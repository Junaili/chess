package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/mail"
	"os"
	"regexp"
	"strings"
	"time"
)

const (
	maxChildAccountBody     = 16 << 10
	maxChildAccountResponse = 1 << 20
)

var childAccountIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)
var childAccountSlugPattern = regexp.MustCompile(`[^a-z0-9]+`)

type childAccountHandler struct {
	agsBaseURL   string
	namespace    string
	clientID     string
	clientSecret string
	httpClient   *http.Client
	now          func() time.Time
}

type childAccountRequest struct {
	GroupID     string `json:"groupId"`
	ParentEmail string `json:"parentEmail"`
	Nickname    string `json:"nickname"`
	BirthYear   int    `json:"birthYear"`
	Password    string `json:"password"`
}

type childAccountResult struct {
	UserID       string `json:"userId"`
	EmailAddress string `json:"emailAddress"`
	DisplayName  string `json:"displayName"`
}

type familyRole struct {
	MemberRoleID   string `json:"memberRoleId"`
	MemberRoleName string `json:"memberRoleName"`
}

type familyMember struct {
	UserID       string `json:"userId"`
	MemberRoleID string `json:"memberRoleId"`
}

type familyGroupDetail struct {
	ConfigurationCode string         `json:"configurationCode"`
	GroupMembers      []familyMember `json:"groupMembers"`
}

func newChildAccountHandlerFromEnv() *childAccountHandler {
	return &childAccountHandler{
		agsBaseURL:   strings.TrimRight(os.Getenv("AB_BASE_URL"), "/"),
		namespace:    os.Getenv("AB_NAMESPACE"),
		clientID:     os.Getenv("AB_CLIENT_ID"),
		clientSecret: os.Getenv("AB_CLIENT_SECRET"),
		httpClient:   &http.Client{Timeout: 12 * time.Second},
		now:          time.Now,
	}
}

func (h *childAccountHandler) create(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeChildAccountError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Use POST to create a child account.")
		return
	}

	var payload childAccountRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxChildAccountBody+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		writeChildAccountError(w, http.StatusBadRequest, "invalid_request", "The child account details are incomplete.")
		return
	}
	if err := validateChildAccountRequest(payload, h.now()); err != nil {
		writeChildAccountError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}

	playerToken := accessTokenFromContext(r.Context())
	playerID := subFromContext(r.Context())
	if playerToken == "" || playerID == "" {
		writeChildAccountError(w, http.StatusUnauthorized, "unauthorized", "Sign in again before creating a child account.")
		return
	}

	verifiedEmail, err := h.guardianEmail(playerToken, playerID, payload.GroupID)
	if err != nil {
		writeChildAccountError(w, childAccountErrorStatus(err), "guardian_required", childAccountErrorMessage(err))
		return
	}

	childEmail, err := buildServerChildEmailAlias(verifiedEmail, payload.Nickname)
	if err != nil {
		writeChildAccountError(w, http.StatusBadGateway, "parent_email_unavailable", "Your account does not have a usable recovery email for the child account.")
		return
	}
	username, err := buildServerChildUsername(payload.Nickname)
	if err != nil {
		writeChildAccountError(w, http.StatusInternalServerError, "identifier_unavailable", "Could not prepare the child account. Please try again.")
		return
	}

	s2sToken, err := h.clientCredentialsToken()
	if err != nil {
		writeChildAccountError(w, http.StatusBadGateway, "service_unavailable", "The account service is temporarily unavailable. Please try again.")
		return
	}

	created, err := h.createAdminUser(s2sToken, childEmail, username, payload)
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, errAdminValidation) {
			status = http.StatusBadRequest
		}
		writeChildAccountError(w, status, "create_failed", err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(childAccountResult{
		UserID:       created,
		EmailAddress: childEmail,
		DisplayName:  strings.TrimSpace(payload.Nickname),
	})
}

func validateChildAccountRequest(payload childAccountRequest, now time.Time) error {
	if !childAccountIDPattern.MatchString(payload.GroupID) {
		return errors.New("The family group could not be found.")
	}
	if strings.TrimSpace(payload.Nickname) == "" || len([]rune(payload.Nickname)) > 48 {
		return errors.New("Choose a nickname with 1 to 48 characters.")
	}
	if len(payload.Password) < 8 || len(payload.Password) > 128 {
		return errors.New("Pick a password with 8 to 128 characters.")
	}
	currentYear := now.Year()
	if payload.BirthYear < currentYear-120 || payload.BirthYear > currentYear {
		return errors.New("Enter a real birth year.")
	}
	// This endpoint is specifically for parent-authorized accounts that are
	// below the normal minimum age. Keep the same conservative year-only rule
	// used by the client: a year difference of 13 may still mean age 12.
	if currentYear-payload.BirthYear >= 14 {
		return errors.New("This child account flow is for players under 13.")
	}
	return nil
}

var (
	errNotGuardian        = errors.New("Only a family guardian can create a child account.")
	errFamilyNotFound     = errors.New("The family group could not be found.")
	errFamilyUnavailable  = errors.New("The family service is temporarily unavailable.")
	errProfileUnavailable = errors.New("Your account email could not be verified.")
	errAdminValidation    = errors.New("The child account details were not accepted. Check the nickname and password.")
)

func childAccountErrorStatus(err error) int {
	switch {
	case errors.Is(err, errNotGuardian):
		return http.StatusForbidden
	case errors.Is(err, errFamilyNotFound):
		return http.StatusNotFound
	default:
		return http.StatusBadGateway
	}
}

func childAccountErrorMessage(err error) string {
	switch {
	case errors.Is(err, errNotGuardian):
		return errNotGuardian.Error()
	case errors.Is(err, errFamilyNotFound):
		return errFamilyNotFound.Error()
	default:
		return "We could not verify your family account. Please try again."
	}
}

func (h *childAccountHandler) guardianEmail(playerToken, playerID, groupID string) (string, error) {
	roles, err := h.getPlayerTokenJSON(playerToken, "/group/v2/public/namespaces/"+h.namespace+"/roles?limit=100")
	if err != nil {
		return "", errFamilyUnavailable
	}
	var rolePayload struct {
		Data []familyRole `json:"data"`
	}
	if err := json.Unmarshal(roles, &rolePayload); err != nil {
		return "", errFamilyUnavailable
	}
	roleNames := make(map[string]string, len(rolePayload.Data))
	for _, role := range rolePayload.Data {
		roleNames[role.MemberRoleID] = strings.ToLower(strings.TrimSpace(role.MemberRoleName))
	}

	detailRaw, err := h.getPlayerTokenJSON(playerToken, "/group/v1/public/namespaces/"+h.namespace+"/groups/"+groupID)
	if err != nil {
		return "", errFamilyNotFound
	}
	var detail familyGroupDetail
	if err := json.Unmarshal(detailRaw, &detail); err != nil || detail.ConfigurationCode != familyConfigurationCode {
		return "", errFamilyNotFound
	}
	guardian := false
	for _, member := range detail.GroupMembers {
		if member.UserID == playerID && roleNames[member.MemberRoleID] == "guardian" {
			guardian = true
			break
		}
	}
	if !guardian {
		return "", errNotGuardian
	}

	profileRaw, err := h.getPlayerTokenJSON(playerToken, "/iam/v3/public/users/me")
	if err != nil {
		return "", errProfileUnavailable
	}
	var profile struct {
		EmailAddress string `json:"emailAddress"`
	}
	if err := json.Unmarshal(profileRaw, &profile); err != nil || !usableEmail(profile.EmailAddress) {
		return "", errProfileUnavailable
	}
	return strings.TrimSpace(profile.EmailAddress), nil
}

func (h *childAccountHandler) getPlayerTokenJSON(token, path string) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, h.agsBaseURL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxChildAccountResponse+1))
	if err != nil || len(body) > maxChildAccountResponse {
		return nil, errors.New("response too large")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("player request returned %d", resp.StatusCode)
	}
	return body, nil
}

func (h *childAccountHandler) clientCredentialsToken() (string, error) {
	values := "grant_type=client_credentials"
	req, err := http.NewRequest(http.MethodPost, h.agsBaseURL+"/iam/v3/oauth/token", strings.NewReader(values))
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
		return "", fmt.Errorf("client credentials returned %d", resp.StatusCode)
	}
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&token); err != nil {
		return "", err
	}
	if token.AccessToken == "" {
		return "", errors.New("client credentials returned no token")
	}
	return token.AccessToken, nil
}

func (h *childAccountHandler) createAdminUser(token, email, username string, payload childAccountRequest) (string, error) {
	body, err := json.Marshal(map[string]any{
		"authType":          "EMAILPASSWD",
		"country":           "US",
		"emailAddress":      email,
		"username":          username,
		"password":          payload.Password,
		"displayName":       strings.TrimSpace(payload.Nickname),
		"uniqueDisplayName": strings.TrimSpace(payload.Nickname),
		"dateOfBirth":       fmt.Sprintf("%04d-12-31", payload.BirthYear),
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequest(http.MethodPost, h.agsBaseURL+"/iam/v4/admin/namespaces/"+h.namespace+"/users", strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	responseBody, readErr := io.ReadAll(io.LimitReader(resp.Body, maxChildAccountResponse+1))
	if readErr != nil || len(responseBody) > maxChildAccountResponse {
		return "", errors.New("invalid account service response")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if resp.StatusCode >= 400 && resp.StatusCode < 500 {
			return "", errAdminValidation
		}
		return "", fmt.Errorf("admin create returned %d", resp.StatusCode)
	}
	var created struct {
		UserID string `json:"userId"`
		Data   struct {
			UserID string `json:"userId"`
		} `json:"data"`
	}
	if err := json.Unmarshal(responseBody, &created); err != nil {
		return "", errors.New("invalid account service response")
	}
	if created.UserID != "" {
		return created.UserID, nil
	}
	if created.Data.UserID != "" {
		return created.Data.UserID, nil
	}
	return "", errors.New("account service returned no user id")
}

func usableEmail(value string) bool {
	value = strings.TrimSpace(value)
	parsed, err := mail.ParseAddress(value)
	return err == nil && parsed.Address == value && strings.Contains(value, "@") && !strings.ContainsAny(value, "\r\n")
}

func buildServerChildEmailAlias(parentEmail, nickname string) (string, error) {
	if !usableEmail(parentEmail) {
		return "", errors.New("invalid parent email")
	}
	parts := strings.SplitN(parentEmail, "@", 2)
	local := strings.SplitN(parts[0], "+", 2)[0]
	if len(local) > 40 {
		local = local[:40]
	}
	return local + "+chess-" + childAccountSlug(nickname) + "-" + randomHex(3) + "@" + parts[1], nil
}

func buildServerChildUsername(nickname string) (string, error) {
	return childAccountSlug(nickname) + randomHex(4), nil
}

func childAccountSlug(value string) string {
	slug := childAccountSlugPattern.ReplaceAllString(strings.ToLower(value), "")
	if slug == "" {
		slug = "child"
	}
	if len(slug) > 12 {
		slug = slug[:12]
	}
	return slug
}

func randomHex(size int) string {
	bytes := make([]byte, size)
	if _, err := rand.Read(bytes); err != nil {
		return hex.EncodeToString(make([]byte, size))
	}
	return hex.EncodeToString(bytes)
}

func writeChildAccountError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message, "code": code})
}
