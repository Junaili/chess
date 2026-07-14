package main

// Server-side family role resolution: is the caller a guardian or a child,
// and who is their guardian?
//
// ⚠️ CORRECTED 2026-07-13 after live verification against production: this
// AGS Group service deployment rejects the Extend service's S2S
// (client-credentials) token OUTRIGHT for every Group endpoint tested —
// including the ADMIN "get arbitrary user's groups" endpoint AND the
// "public" roles catalog — with 403 "access forbidden: token is not user
// token". There is no S2S path into Group at all in this deployment. Every
// call below therefore uses the CALLER's own forwarded bearer token
// (accessTokenFromContext), the same pattern family_group_proxy.go already
// uses successfully in production.
//
// The practical consequence: this package can only ever resolve the
// CALLER's own family membership, never look up an arbitrary other user's
// group from scratch. That turns out to be sufficient for every real call
// site:
//   - /club/status (child checking their guardian's plan): the caller IS
//     the child: use their own token to find their own group + guardian.
//   - /club/web-checkout child-purchase block: the caller's own role.
//   - /coins/give guardian check: the caller IS the guardian; verify the
//     recipient is listed as a member of the CALLER's own group — never an
//     independent lookup of the recipient.
//
// Field names (groupId/status/groupMembers/memberRoleId/memberRoleName) are
// taken verbatim from src/family.js, which documents itself as "verified
// live against the seal shared-cloud tier 2026-07-07" for these same
// public/player-token endpoints.
//
// Roles are configured at the namespace level (provisioned by
// scripts/provision-ags-family.mjs) with names "guardian" and "child" — never
// hardcoded IDs, matching src/family-feedback.mjs's resolveMemberRole.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	familyConfigCode    = "chess-family"
	familyRolesCacheTTL = 6 * time.Hour
)

type familyRolesCache struct {
	h  *monetizationHandler
	mu sync.RWMutex

	byRoleID map[string]string // memberRoleId -> memberRoleName ("guardian"/"child")
	loadedAt time.Time
}

func newFamilyRolesCache(h *monetizationHandler) *familyRolesCache {
	return &familyRolesCache{h: h, byRoleID: map[string]string{}}
}

type agsRolesResponse struct {
	Data []struct {
		MemberRoleID   string `json:"memberRoleId"`
		MemberRoleName string `json:"memberRoleName"`
	} `json:"data"`
}

// rolesByID fetches the namespace's role catalog using callerToken — ANY
// authenticated user token works, since the catalog is namespace-wide, not
// user-scoped. Cached across all callers (roles are provisioned once and
// essentially never change).
func (c *familyRolesCache) rolesByID(callerToken string) (map[string]string, error) {
	c.mu.RLock()
	fresh := time.Since(c.loadedAt) < familyRolesCacheTTL && len(c.byRoleID) > 0
	roles := c.byRoleID
	c.mu.RUnlock()
	if fresh {
		return roles, nil
	}
	if callerToken == "" {
		return nil, errors.New("no caller token available to fetch the group roles catalog")
	}

	endpoint := fmt.Sprintf("%s/group/v2/public/namespaces/%s/roles?limit=100", c.h.agsBaseURL, url.PathEscape(c.h.namespace))
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+callerToken)
	resp, err := c.h.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil, fmt.Errorf("group roles catalog returned %d", resp.StatusCode)
	}
	var parsed agsRolesResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("decode group roles: %w", err)
	}
	byID := make(map[string]string, len(parsed.Data))
	for _, r := range parsed.Data {
		byID[r.MemberRoleID] = r.MemberRoleName
	}

	c.mu.Lock()
	c.byRoleID = byID
	c.loadedAt = time.Now()
	c.mu.Unlock()
	return byID, nil
}

// resolveRoleName mirrors src/family-feedback.mjs's resolveMemberRole:
// guardian wins if present among the member's role ids, else child (fail
// closed, matching the client).
func resolveRoleName(memberRoleIDs []string, rolesByID map[string]string) string {
	names := make([]string, 0, len(memberRoleIDs))
	for _, id := range memberRoleIDs {
		if name, ok := rolesByID[id]; ok {
			names = append(names, name)
		}
	}
	for _, n := range names {
		if n == "guardian" {
			return "guardian"
		}
	}
	return "child"
}

type agsMyGroupsResponse struct {
	Data []struct {
		GroupID string `json:"groupId"`
		Status  string `json:"status"`
	} `json:"data"`
}

type agsGroupDetailResponse struct {
	GroupID           string `json:"groupId"`
	ConfigurationCode string `json:"configurationCode"`
	GroupMembers      []struct {
		UserID       string   `json:"userId"`
		MemberRoleID []string `json:"memberRoleId"`
	} `json:"groupMembers"`
}

// myFamilyGroup returns the chess-family group the CALLER (owner of
// callerToken) has JOINED, or nil if they're not in one. Uses the public
// "me" endpoint — the only Group API surface this deployment accepts from a
// server-side caller (still requires a real user token, just not an
// admin-path endpoint).
func (h *monetizationHandler) myFamilyGroup(callerToken string) (*agsGroupDetailResponse, error) {
	if callerToken == "" {
		return nil, errors.New("no caller token available for family lookup")
	}
	endpoint := fmt.Sprintf("%s/group/v2/public/namespaces/%s/users/me/groups?limit=10",
		h.agsBaseURL, url.PathEscape(h.namespace))
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+callerToken)
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusNotFound {
		resp.Body.Close()
		return nil, nil // "user not belong to any group" — not an error
	}
	var groups agsMyGroupsResponse
	decodeErr := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&groups)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("my-groups lookup returned %d", resp.StatusCode)
	}
	if decodeErr != nil {
		return nil, fmt.Errorf("decode my-groups: %w", decodeErr)
	}

	var groupID string
	for _, g := range groups.Data {
		if strings.EqualFold(g.Status, "JOINED") {
			groupID = g.GroupID
			break
		}
	}
	if groupID == "" {
		return nil, nil
	}

	detailEndpoint := fmt.Sprintf("%s/group/v1/public/namespaces/%s/groups/%s",
		h.agsBaseURL, url.PathEscape(h.namespace), url.PathEscape(groupID))
	detailReq, err := http.NewRequest(http.MethodGet, detailEndpoint, nil)
	if err != nil {
		return nil, err
	}
	detailReq.Header.Set("Authorization", "Bearer "+callerToken)
	detailResp, err := h.httpClient.Do(detailReq)
	if err != nil {
		return nil, err
	}
	defer detailResp.Body.Close()
	if detailResp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(detailResp.Body, 64<<10))
		return nil, fmt.Errorf("group detail for %s returned %d", groupID, detailResp.StatusCode)
	}
	var detail agsGroupDetailResponse
	if err := json.NewDecoder(io.LimitReader(detailResp.Body, 256<<10)).Decode(&detail); err != nil {
		return nil, fmt.Errorf("decode group detail for %s: %w", groupID, err)
	}
	if detail.ConfigurationCode != familyConfigCode {
		return nil, nil // a non-family group type — treat as no family
	}
	return &detail, nil
}

// resolveSelf returns (role, guardianUserID) for the CALLER (callerUserID,
// owner of callerToken). role is "guardian", "child", or "" (not in a
// family at all). guardianUserID is only populated when role == "child".
func (c *familyRolesCache) resolveSelf(callerUserID, callerToken string) (role string, guardianUserID string, err error) {
	detail, err := c.h.myFamilyGroup(callerToken)
	if err != nil {
		return "", "", err
	}
	if detail == nil {
		return "", "", nil
	}
	rolesByID, err := c.rolesByID(callerToken)
	if err != nil {
		return "", "", err
	}
	var selfRole string
	for _, m := range detail.GroupMembers {
		if m.UserID != callerUserID {
			continue
		}
		selfRole = resolveRoleName(m.MemberRoleID, rolesByID)
	}
	if selfRole == "guardian" {
		return "guardian", "", nil
	}
	// Child (or unresolved — fail closed to "child"): find the group's
	// guardian.
	for _, m := range detail.GroupMembers {
		if resolveRoleName(m.MemberRoleID, rolesByID) == "guardian" {
			return "child", m.UserID, nil
		}
	}
	return "child", "", nil
}

// isGuardianOfWithinOwnGroup reports whether recipientID is a member of the
// CALLER's own family group AND the caller is that group's guardian — used
// by /coins/give. Deliberately never looks up the recipient independently
// (which would require a token this service does not have); it only checks
// membership within the group the caller's OWN token proves they belong to.
func (c *familyRolesCache) isGuardianOfWithinOwnGroup(callerUserID, callerToken, recipientID string) (bool, error) {
	role, _, err := c.resolveSelf(callerUserID, callerToken)
	if err != nil {
		return false, err
	}
	if role != "guardian" {
		return false, nil
	}
	detail, err := c.h.myFamilyGroup(callerToken)
	if err != nil {
		return false, err
	}
	if detail == nil {
		return false, nil
	}
	for _, m := range detail.GroupMembers {
		if m.UserID == recipientID {
			return true, nil
		}
	}
	return false, nil
}
