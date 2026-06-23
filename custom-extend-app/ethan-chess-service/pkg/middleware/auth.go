package middleware

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"
)

type AGSAuth struct {
	baseURL      string
	clientID     string
	clientSecret string
}

func NewAGSAuth(baseURL, clientID, clientSecret string) *AGSAuth {
	return &AGSAuth{
		baseURL:      strings.TrimRight(baseURL, "/"),
		clientID:     clientID,
		clientSecret: clientSecret,
	}
}

type introspectResp struct {
	Active bool `json:"active"`
}

func (a *AGSAuth) Validate() gin.HandlerFunc {
	return func(c *gin.Context) {
		// Skip validation in local dev when no client secret is configured
		if a.clientSecret == "" {
			c.Next()
			return
		}

		header := c.GetHeader("Authorization")
		if !strings.HasPrefix(header, "Bearer ") {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing bearer token"})
			return
		}
		token := strings.TrimPrefix(header, "Bearer ")

		active, err := a.introspect(token)
		if err != nil || !active {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired token"})
			return
		}
		c.Next()
	}
}

func (a *AGSAuth) introspect(token string) (bool, error) {
	endpoint := fmt.Sprintf("%s/iam/v3/oauth/introspect", a.baseURL)

	body := url.Values{}
	body.Set("token", token)

	req, err := http.NewRequest(http.MethodPost, endpoint, strings.NewReader(body.Encode()))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(a.clientID, a.clientSecret)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, err
	}

	var result introspectResp
	if err := json.Unmarshal(raw, &result); err != nil {
		return false, err
	}
	return result.Active, nil
}
