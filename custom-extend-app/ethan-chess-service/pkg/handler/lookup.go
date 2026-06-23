package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
)

type LookupResult struct {
	Found       bool   `json:"found"`
	UserID      string `json:"userId,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
}

func LookupByEmail(c *gin.Context) {
	email := strings.TrimSpace(c.Query("email"))
	if email == "" || !strings.Contains(email, "@") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "valid email required"})
		return
	}

	result, err := lookupEmailInIAM(email)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "lookup failed"})
		return
	}

	c.JSON(http.StatusOK, result)
}

func lookupEmailInIAM(email string) (*LookupResult, error) {
	baseURL := strings.TrimRight(os.Getenv("AB_BASE_URL"), "/")
	clientID := os.Getenv("AB_CLIENT_ID")
	clientSecret := os.Getenv("AB_CLIENT_SECRET")
	namespace := os.Getenv("AB_NAMESPACE")

	token, err := getClientCredentialsToken(baseURL, clientID, clientSecret)
	if err != nil {
		return nil, fmt.Errorf("get token: %w", err)
	}

	reqURL := fmt.Sprintf("%s/iam/v3/admin/namespaces/%s/users?emailAddress=%s",
		baseURL, namespace, url.QueryEscape(email))

	req, err := http.NewRequest(http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == http.StatusNotFound {
		return &LookupResult{Found: false}, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("IAM returned %d: %s", resp.StatusCode, string(body))
	}

	var user struct {
		UserID      string `json:"userId"`
		DisplayName string `json:"displayName"`
	}
	if err := json.Unmarshal(body, &user); err != nil {
		return nil, err
	}
	if user.UserID == "" {
		return &LookupResult{Found: false}, nil
	}

	return &LookupResult{
		Found:       true,
		UserID:      user.UserID,
		DisplayName: user.DisplayName,
	}, nil
}

func getClientCredentialsToken(baseURL, clientID, clientSecret string) (string, error) {
	data := url.Values{}
	data.Set("grant_type", "client_credentials")

	req, err := http.NewRequest(http.MethodPost, baseURL+"/iam/v3/oauth/token",
		strings.NewReader(data.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(clientID, clientSecret)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var tokenResp struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		return "", err
	}
	if tokenResp.AccessToken == "" {
		return "", fmt.Errorf("empty access token from IAM")
	}
	return tokenResp.AccessToken, nil
}
