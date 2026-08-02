package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
	"github.com/junaili/ethan-chess-service/pkg/botgame"
	"github.com/pion/webrtc/v3"
)

// agsSessionClient is deliberately small: importing the generated full AGS SDK
// made a one-second bot build take more than ten minutes. This client contains
// only the IAM and Session endpoints required by the DS lifecycle.
type agsSessionClient struct {
	baseURL, namespace, clientID, clientSecret string
	httpClient                                 *http.Client
}

type claimedSession struct {
	ID      string                     `json:"id"`
	Storage map[string]json.RawMessage `json:"storage"`
}

func (c *agsSessionClient) sessionByID(ctx context.Context, sessionID string) (*claimedSession, error) {
	token, err := c.token(ctx)
	if err != nil {
		return nil, err
	}
	path := fmt.Sprintf("/session/v1/public/namespaces/%s/gamesessions/%s", url.PathEscape(c.namespace), url.PathEscape(sessionID))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("AGS session read returned %s", resp.Status)
	}
	var session claimedSession
	if err := json.NewDecoder(io.LimitReader(resp.Body, 256<<10)).Decode(&session); err != nil {
		return nil, err
	}
	return &session, nil
}

func (c *agsSessionClient) patchStorage(ctx context.Context, sessionID string, storage map[string]json.RawMessage) error {
	token, err := c.token(ctx)
	if err != nil {
		return err
	}
	body, err := json.Marshal(map[string]any{"storage": storage})
	if err != nil {
		return err
	}
	path := fmt.Sprintf("/session/v1/public/namespaces/%s/gamesessions/%s", url.PathEscape(c.namespace), url.PathEscape(sessionID))
	req, err := http.NewRequestWithContext(ctx, http.MethodPatch, c.baseURL+path, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("AGS session storage update returned %s", resp.Status)
	}
	return nil
}

type botSignal struct {
	SessionID string                     `json:"sessionId"`
	Nonce     string                     `json:"nonce"`
	Offer     *webrtc.SessionDescription `json:"offer,omitempty"`
	Answer    *webrtc.SessionDescription `json:"answer,omitempty"`
}

// answerSignal waits for the one offer belonging to this claimed session and
// writes an answer using the same nonce. The nonce protects against a stale
// offer left behind by an earlier connection attempt.
func (c *agsSessionClient) answerSignal(ctx context.Context, sessionID string, bot *botbrain.Bot, signalKey string) (*webrtc.PeerConnection, error) {
	for {
		session, err := c.sessionByID(ctx, sessionID)
		if err != nil {
			return nil, err
		}
		var signal botSignal
		if raw := session.Storage[signalKey]; len(raw) != 0 {
			if err := json.Unmarshal(raw, &signal); err != nil {
				return nil, fmt.Errorf("decode %s: %w", signalKey, err)
			}
		}
		if signal.SessionID == sessionID && signal.Nonce != "" && signal.Offer != nil && signal.Answer == nil {
			answer, pc, err := botgame.AnswerContext(ctx, *signal.Offer, bot.Style, bot.Name)
			if err != nil {
				return nil, err
			}
			signal.Answer = &answer
			raw, _ := json.Marshal(signal)
			if session.Storage == nil {
				session.Storage = map[string]json.RawMessage{}
			}
			session.Storage[signalKey] = raw
			if err := c.patchStorage(ctx, sessionID, session.Storage); err != nil {
				_ = pc.Close()
				return nil, err
			}
			return pc, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(750 * time.Millisecond):
		}
	}
}

func newAGSSessionClient() (*agsSessionClient, bool) {
	value := func(botKey, defaultKey string) string {
		if v := strings.TrimSpace(os.Getenv(botKey)); v != "" {
			return v
		}
		return strings.TrimSpace(os.Getenv(defaultKey))
	}
	c := &agsSessionClient{
		baseURL: value("BOT_BASE_URL", "AB_BASE_URL"), namespace: value("BOT_NAMESPACE", "AB_NAMESPACE"),
		clientID: value("BOT_CLIENT_ID", "AB_CLIENT_ID"), clientSecret: value("BOT_CLIENT_SECRET", "AB_CLIENT_SECRET"),
		httpClient: &http.Client{Timeout: 12 * time.Second},
	}
	c.baseURL = strings.TrimRight(c.baseURL, "/")
	return c, c.baseURL != "" && c.namespace != "" && c.clientID != "" && c.clientSecret != ""
}

func (c *agsSessionClient) token(ctx context.Context) (string, error) {
	body := url.Values{"grant_type": {"client_credentials"}, "client_id": {c.clientID}, "client_secret": {c.clientSecret}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/iam/v3/oauth/token", strings.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("AGS login returned %s", resp.Status)
	}
	var result struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&result); err != nil {
		return "", err
	}
	if result.AccessToken == "" {
		return "", fmt.Errorf("AGS login returned no access token")
	}
	return result.AccessToken, nil
}

func (c *agsSessionClient) claimedSession(ctx context.Context, podName string) (*claimedSession, error) {
	token, err := c.token(ctx)
	if err != nil {
		return nil, err
	}
	path := fmt.Sprintf("/session/v1/public/namespaces/%s/gamesessions/servers/%s", url.PathEscape(c.namespace), url.PathEscape(podName))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("AGS session lookup returned %s", resp.Status)
	}
	var session claimedSession
	if err := json.NewDecoder(io.LimitReader(resp.Body, 256<<10)).Decode(&session); err != nil {
		return nil, err
	}
	if session.ID == "" {
		return nil, fmt.Errorf("AGS session lookup returned no session id")
	}
	return &session, nil
}

func (c *agsSessionClient) setReady(ctx context.Context, sessionID string) error {
	token, err := c.token(ctx)
	if err != nil {
		return err
	}
	path := fmt.Sprintf("/session/v1/admin/namespaces/%s/gamesessions/%s/ds", url.PathEscape(c.namespace), url.PathEscape(sessionID))
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, c.baseURL+path, strings.NewReader(`{"ready":true}`))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("AGS set-ready returned %s", resp.Status)
	}
	return nil
}

func (c *agsSessionClient) waitForClaim(ctx context.Context, podName string) (*claimedSession, error) {
	for {
		session, err := c.claimedSession(ctx, podName)
		if err == nil && session != nil {
			return session, nil
		}
		if err != nil {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}
