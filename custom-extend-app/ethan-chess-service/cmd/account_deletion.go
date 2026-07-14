package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type accountDeletionHandler struct {
	agsBaseURL      string
	namespace       string
	clientID        string
	clientSecret    string
	appleBaseURL    string
	appleTeamID     string
	appleKeyID      string
	appleClientID   string
	applePrivateKey string
	httpClient      *http.Client
	now             func() time.Time

	// monetization is set post-construction in main.go (nil-safe: existing
	// tests construct accountDeletionHandler directly and never set this).
	// Used for the dev-plan §11.8 integration: cancel any Stripe subscription
	// and flag an active Apple-billed Club plan before/during deletion.
	monetization *monetizationHandler
}

func newAccountDeletionHandlerFromEnv() *accountDeletionHandler {
	return &accountDeletionHandler{
		agsBaseURL:      strings.TrimRight(os.Getenv("AB_BASE_URL"), "/"),
		namespace:       os.Getenv("AB_NAMESPACE"),
		clientID:        os.Getenv("AB_CLIENT_ID"),
		clientSecret:    os.Getenv("AB_CLIENT_SECRET"),
		appleBaseURL:    strings.TrimRight(defaultString(os.Getenv("APPLE_AUTH_BASE_URL"), "https://appleid.apple.com"), "/"),
		appleTeamID:     os.Getenv("APPLE_TEAM_ID"),
		appleKeyID:      os.Getenv("APPLE_KEY_ID"),
		appleClientID:   os.Getenv("APPLE_CLIENT_ID"),
		applePrivateKey: os.Getenv("APPLE_PRIVATE_KEY_B64"),
		httpClient:      &http.Client{Timeout: 12 * time.Second},
		now:             time.Now,
	}
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func (h *accountDeletionHandler) requirements(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodGet {
		writeDeletionError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
		return
	}

	userID := subFromContext(r.Context())
	if userID == "" {
		writeDeletionError(w, http.StatusUnauthorized, "unauthenticated", "Sign in again before deleting your account.")
		return
	}

	appleLinked, err := h.isAppleLinked(userID)
	if err != nil {
		writeDeletionError(w, http.StatusBadGateway, "requirements_unavailable", "Could not verify linked login methods. Try again.")
		return
	}
	if appleLinked && !h.appleConfigured() {
		writeDeletionError(w, http.StatusServiceUnavailable, "apple_revocation_unavailable", "Account deletion is temporarily unavailable. Try again later.")
		return
	}

	// dev-plan §11.8: surface Club billing state so the client can warn
	// "deleting your account does not cancel your App Store subscription"
	// (Apple) or simply note that a web subscription will be cancelled
	// automatically (Stripe) — and forfeited coins, if any.
	var appleClubActive bool
	var coinBalance int64
	if h.monetization != nil {
		if entitlements, err := h.monetization.activeClubEntitlements(userID); err == nil {
			if best := bestActiveEntitlement(entitlements, h.monetization.now()); best != nil && best.Origin == "apple" {
				appleClubActive = true
			}
		}
		if balance, err := h.monetization.getWalletBalance(userID); err == nil {
			coinBalance = balance
		}
	}

	_ = json.NewEncoder(w).Encode(map[string]any{
		"available":                    true,
		"appleLinked":                  appleLinked,
		"appleReauthorizationRequired": appleLinked,
		"appleClubSubscriptionActive":  appleClubActive,
		"coinBalance":                  coinBalance,
	})
}

func (h *accountDeletionHandler) deleteAccount(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		writeDeletionError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
		return
	}

	userID := subFromContext(r.Context())
	if userID == "" {
		writeDeletionError(w, http.StatusUnauthorized, "unauthenticated", "Sign in again before deleting your account.")
		return
	}

	var body struct {
		Confirmation           string `json:"confirmation"`
		AppleAuthorizationCode string `json:"appleAuthorizationCode"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&body); err != nil {
		writeDeletionError(w, http.StatusBadRequest, "invalid_request", "Invalid deletion request.")
		return
	}
	if body.Confirmation != "DELETE" {
		writeDeletionError(w, http.StatusBadRequest, "confirmation_required", "Type DELETE to confirm account deletion.")
		return
	}

	appleLinked, err := h.isAppleLinked(userID)
	if err != nil {
		writeDeletionError(w, http.StatusBadGateway, "requirements_unavailable", "Could not verify linked login methods. Your account was not deleted.")
		return
	}
	if appleLinked {
		code := strings.TrimSpace(body.AppleAuthorizationCode)
		if code == "" {
			writeDeletionError(w, http.StatusBadRequest, "apple_reauthorization_required", "Sign in with Apple again to confirm deletion.")
			return
		}
		if !h.appleConfigured() {
			writeDeletionError(w, http.StatusServiceUnavailable, "apple_revocation_unavailable", "Account deletion is temporarily unavailable. Your account was not deleted.")
			return
		}
		if err := h.revokeAppleAuthorization(code); err != nil {
			writeDeletionError(w, http.StatusBadGateway, "apple_revocation_failed", "Apple authorization could not be revoked. Your account was not deleted; try again.")
			return
		}
	}

	// dev-plan §11.8: cancel any Stripe subscription before submitting GDPR
	// deletion. Log-and-continue on failure — deletion must never be blocked
	// by a Stripe hiccup, but an orphaned subscription needs manual cleanup.
	if h.monetization != nil {
		if ledger, _, err := h.monetization.readLedger(userID); err == nil && ledger.StripeCustomerID != "" {
			if err := h.monetization.cancelStripeSubscriptionsForCustomer(ledger.StripeCustomerID); err != nil {
				log.Printf("[account-deletion] failed to cancel Stripe subscriptions for user %s (customer %s), needs manual cleanup: %v", userID, ledger.StripeCustomerID, err)
			}
		}
	}

	if err := h.submitAGSDeletion(userID); err != nil {
		writeDeletionError(w, http.StatusBadGateway, "ags_deletion_failed", "AGS did not accept the deletion request. Your account was not deleted; try again.")
		return
	}

	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"accepted": true,
		"message":  "Your account deletion request was accepted.",
	})
}

func writeDeletionError(w http.ResponseWriter, status int, code, message string) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error":   code,
		"message": message,
	})
}

func (h *accountDeletionHandler) clientCredentialsToken() (string, error) {
	values := url.Values{"grant_type": {"client_credentials"}}
	req, err := http.NewRequest(http.MethodPost, h.agsBaseURL+"/iam/v3/oauth/token", strings.NewReader(values.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(h.clientID, h.clientSecret)

	resp, err := h.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return "", fmt.Errorf("client credentials returned %d", resp.StatusCode)
	}

	var payload struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&payload); err != nil {
		return "", err
	}
	if payload.AccessToken == "" {
		return "", errors.New("client credentials returned no access token")
	}
	return payload.AccessToken, nil
}

func (h *accountDeletionHandler) isAppleLinked(userID string) (bool, error) {
	token, err := h.clientCredentialsToken()
	if err != nil {
		return false, err
	}
	endpoint := fmt.Sprintf(
		"%s/iam/v3/admin/namespaces/%s/users/%s/platforms/distinct?status=LINKED",
		h.agsBaseURL,
		url.PathEscape(h.namespace),
		url.PathEscape(userID),
	)
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := h.httpClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return false, fmt.Errorf("linked platform lookup returned %d", resp.StatusCode)
	}

	var payload struct {
		Platforms []struct {
			PlatformName string `json:"platformName"`
			Status       string `json:"status"`
		} `json:"platforms"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 256<<10)).Decode(&payload); err != nil {
		return false, err
	}
	for _, platform := range payload.Platforms {
		if strings.EqualFold(platform.PlatformName, "apple") &&
			(platform.Status == "" || strings.EqualFold(platform.Status, "LINKED")) {
			return true, nil
		}
	}
	return false, nil
}

func (h *accountDeletionHandler) appleConfigured() bool {
	return h.appleTeamID != "" && h.appleKeyID != "" && h.appleClientID != "" && h.applePrivateKey != ""
}

func (h *accountDeletionHandler) revokeAppleAuthorization(code string) error {
	clientSecret, err := h.appleClientSecret()
	if err != nil {
		return err
	}
	exchange := url.Values{
		"client_id":     {h.appleClientID},
		"client_secret": {clientSecret},
		"code":          {code},
		"grant_type":    {"authorization_code"},
	}
	resp, err := h.postAppleForm("/auth/token", exchange)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return fmt.Errorf("apple token exchange returned %d", resp.StatusCode)
	}
	var tokenPayload struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&tokenPayload); err != nil {
		return err
	}
	token := tokenPayload.RefreshToken
	hint := "refresh_token"
	if token == "" {
		token = tokenPayload.AccessToken
		hint = "access_token"
	}
	if token == "" {
		return errors.New("apple token exchange returned no revocable token")
	}

	revoke := url.Values{
		"client_id":       {h.appleClientID},
		"client_secret":   {clientSecret},
		"token":           {token},
		"token_type_hint": {hint},
	}
	revokeResp, err := h.postAppleForm("/auth/revoke", revoke)
	if err != nil {
		return err
	}
	defer revokeResp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(revokeResp.Body, 64<<10))
	if revokeResp.StatusCode < 200 || revokeResp.StatusCode >= 300 {
		return fmt.Errorf("apple revoke returned %d", revokeResp.StatusCode)
	}
	return nil
}

func (h *accountDeletionHandler) postAppleForm(path string, values url.Values) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodPost, h.appleBaseURL+path, strings.NewReader(values.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return h.httpClient.Do(req)
}

func (h *accountDeletionHandler) appleClientSecret() (string, error) {
	privateKey, err := parseApplePrivateKey(h.applePrivateKey)
	if err != nil {
		return "", err
	}
	now := h.now()
	header, _ := json.Marshal(map[string]string{"alg": "ES256", "kid": h.appleKeyID, "typ": "JWT"})
	claims, _ := json.Marshal(map[string]any{
		"iss": h.appleTeamID,
		"iat": now.Unix(),
		"exp": now.Add(5 * time.Minute).Unix(),
		"aud": "https://appleid.apple.com",
		"sub": h.appleClientID,
	})
	encodedHeader := base64.RawURLEncoding.EncodeToString(header)
	encodedClaims := base64.RawURLEncoding.EncodeToString(claims)
	signingInput := encodedHeader + "." + encodedClaims
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, privateKey, digest[:])
	if err != nil {
		return "", err
	}
	signature := append(paddedBigInt(r, 32), paddedBigInt(s, 32)...)
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func parseApplePrivateKey(encoded string) (*ecdsa.PrivateKey, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		raw, err = base64.RawStdEncoding.DecodeString(strings.TrimSpace(encoded))
	}
	if err != nil {
		return nil, errors.New("APPLE_PRIVATE_KEY_B64 is not valid base64")
	}
	block, _ := pem.Decode(bytes.TrimSpace(raw))
	if block == nil {
		return nil, errors.New("APPLE_PRIVATE_KEY_B64 does not contain a PEM key")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse Apple private key: %w", err)
	}
	ecKey, ok := key.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("Apple private key is not EC")
	}
	return ecKey, nil
}

func paddedBigInt(value *big.Int, size int) []byte {
	result := make([]byte, size)
	raw := value.Bytes()
	copy(result[size-len(raw):], raw)
	return result
}

func (h *accountDeletionHandler) submitAGSDeletion(userID string) error {
	token, err := h.clientCredentialsToken()
	if err != nil {
		return err
	}
	endpoint := fmt.Sprintf(
		"%s/gdpr/s2s/namespaces/%s/users/%s/deletions",
		h.agsBaseURL,
		url.PathEscape(h.namespace),
		url.PathEscape(userID),
	)
	req, err := http.NewRequest(http.MethodPost, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("AGS GDPR deletion returned %d", resp.StatusCode)
	}
	return nil
}
