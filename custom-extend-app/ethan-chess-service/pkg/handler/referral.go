package handler

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
)

const recruiterAchievementCode = "chess-recruiter"

// UnlockRecruiterAchievement unlocks the chess-recruiter achievement for the
// inviter once a newly-registered user reports who referred them. It uses the
// server-side client-credentials token (same pattern as the IAM lookup) to call
// the AGS Achievement admin unlock endpoint. Re-unlocking is treated as success.
func UnlockRecruiterAchievement(inviterUserID string) error {
	baseURL := strings.TrimRight(os.Getenv("AB_BASE_URL"), "/")
	clientID := os.Getenv("AB_CLIENT_ID")
	clientSecret := os.Getenv("AB_CLIENT_SECRET")
	namespace := os.Getenv("AB_NAMESPACE")
	if namespace == "" {
		return fmt.Errorf("AB_NAMESPACE not configured")
	}

	token, err := getClientCredentialsToken(baseURL, clientID, clientSecret)
	if err != nil {
		return fmt.Errorf("get token: %w", err)
	}

	reqURL := fmt.Sprintf("%s/achievement/v1/admin/namespaces/%s/users/%s/achievements/%s/unlock",
		baseURL, namespace, url.PathEscape(inviterUserID), recruiterAchievementCode)

	req, err := http.NewRequest(http.MethodPut, reqURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := outboundHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	// 409 = already unlocked, which is a perfectly fine outcome.
	if resp.StatusCode == http.StatusConflict {
		return nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return fmt.Errorf("achievement unlock returned status %d", resp.StatusCode)
	}
	return nil
}
