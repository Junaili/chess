package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

var outboundHTTPClient = &http.Client{Timeout: 10 * time.Second}

type LookupResult struct {
	Found       bool   `json:"found"`
	UserID      string `json:"userId,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
}

func LookupEmailInIAM(email string) (*LookupResult, error) {
	email = strings.TrimSpace(email)
	if err := ValidateEmailAddress(email); err != nil {
		return nil, err
	}
	baseURL := strings.TrimRight(os.Getenv("AB_BASE_URL"), "/")
	clientID := os.Getenv("AB_CLIENT_ID")
	clientSecret := os.Getenv("AB_CLIENT_SECRET")
	namespace := os.Getenv("AB_NAMESPACE")
	if baseURL == "" || clientID == "" || clientSecret == "" || namespace == "" {
		return nil, fmt.Errorf("IAM configuration is incomplete")
	}

	token, err := getClientCredentialsToken(baseURL, clientID, clientSecret)
	if err != nil {
		return nil, fmt.Errorf("get token: %w", err)
	}

	reqURL := fmt.Sprintf("%s/iam/v3/admin/namespaces/%s/users?emailAddress=%s",
		baseURL, url.PathEscape(namespace), url.QueryEscape(email))

	req, err := http.NewRequest(http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := outboundHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read IAM response: %w", err)
	}

	if resp.StatusCode == http.StatusNotFound {
		return &LookupResult{Found: false}, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("IAM lookup returned status %d", resp.StatusCode)
	}

	// Admin IAM returns a paginated list: {"data": [...], "paging": {...}}
	var page struct {
		Data []struct {
			UserID      string `json:"userId"`
			DisplayName string `json:"displayName"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &page); err != nil {
		return nil, err
	}
	if len(page.Data) == 0 || page.Data[0].UserID == "" {
		return &LookupResult{Found: false}, nil
	}

	return &LookupResult{
		Found:       true,
		UserID:      page.Data[0].UserID,
		DisplayName: page.Data[0].DisplayName,
	}, nil
}

func getClientCredentialsToken(baseURL, clientID, clientSecret string) (string, error) {
	if baseURL == "" || clientID == "" || clientSecret == "" {
		return "", fmt.Errorf("IAM client configuration is incomplete")
	}
	data := url.Values{}
	data.Set("grant_type", "client_credentials")

	req, err := http.NewRequest(http.MethodPost, baseURL+"/iam/v3/oauth/token",
		strings.NewReader(data.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(clientID, clientSecret)

	resp, err := outboundHTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return "", fmt.Errorf("IAM token endpoint returned status %d", resp.StatusCode)
	}

	var tokenResp struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&tokenResp); err != nil {
		return "", err
	}
	if tokenResp.AccessToken == "" {
		return "", fmt.Errorf("empty access token from IAM")
	}
	return tokenResp.AccessToken, nil
}
