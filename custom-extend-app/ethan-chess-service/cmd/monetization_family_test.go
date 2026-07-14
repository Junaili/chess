package main

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestResolveRoleNameGuardianWins(t *testing.T) {
	rolesByID := map[string]string{"role-g": "guardian", "role-c": "child"}
	role := resolveRoleName([]string{"role-c", "role-g"}, rolesByID)
	if role != "guardian" {
		t.Fatalf("role = %q, want guardian", role)
	}
}

func TestResolveRoleNameChildWhenOnlyChildRole(t *testing.T) {
	rolesByID := map[string]string{"role-g": "guardian", "role-c": "child"}
	role := resolveRoleName([]string{"role-c"}, rolesByID)
	if role != "child" {
		t.Fatalf("role = %q, want child", role)
	}
}

// Fail-closed: an unresolvable role id (e.g. the roles catalog changed) must
// never be treated as guardian — mirrors src/family-feedback.mjs exactly.
func TestResolveRoleNameFailsClosedToChild(t *testing.T) {
	role := resolveRoleName([]string{"unknown-role-id"}, map[string]string{})
	if role != "child" {
		t.Fatalf("role = %q, want child (fail closed)", role)
	}
}

func TestResolveRoleNameEmptyRoleIDs(t *testing.T) {
	role := resolveRoleName(nil, map[string]string{"role-g": "guardian"})
	if role != "child" {
		t.Fatalf("role = %q, want child", role)
	}
}

// ---------------------------------------------------------------------------
// resolveSelf / isGuardianOfWithinOwnGroup: live-verified 2026-07-13 that
// this AGS deployment rejects S2S tokens for EVERY Group endpoint (including
// the "public" roles catalog), so these must go through the caller's own
// forwarded token against the "me" endpoints only. This fake transport
// deliberately 403s the admin "arbitrary user" path to catch any regression
// back toward it.
// ---------------------------------------------------------------------------

type familyGroupRoundTripper struct {
	groupID string
	members []struct {
		userID string
		roleID string
	}
	rolesCatalog map[string]string // roleId -> roleName
}

func (f *familyGroupRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	auth := req.Header.Get("Authorization")
	if req.URL.Path == "/iam/v3/oauth/token" {
		return jsonResponse(200, `{"access_token":"server-token"}`), nil
	}
	// This is the exact production 403 (verified live 2026-07-13) — any call
	// here signals a regression back to the broken S2S-token design.
	if strings.Contains(req.URL.Path, "/group/v2/admin/") {
		return jsonResponse(403, `{"errorCode":20022,"errorMessage":"access forbidden: token is not user token"}`), nil
	}
	if !strings.HasPrefix(auth, "Bearer caller-") {
		return jsonResponse(403, `{"errorCode":20022,"errorMessage":"access forbidden: token is not user token"}`), nil
	}

	switch {
	case strings.HasSuffix(req.URL.Path, "/users/me/groups"):
		if f.groupID == "" {
			return &http.Response{StatusCode: 404, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`)), Request: req}, nil
		}
		return jsonResponse(200, `{"data":[{"groupId":"`+f.groupID+`","status":"JOINED"}]}`), nil
	case strings.Contains(req.URL.Path, "/group/v1/public/") && strings.Contains(req.URL.Path, "/groups/"+f.groupID):
		members := "["
		for i, m := range f.members {
			if i > 0 {
				members += ","
			}
			members += `{"userId":"` + m.userID + `","memberRoleId":["` + m.roleID + `"]}`
		}
		members += "]"
		return jsonResponse(200, `{"groupId":"`+f.groupID+`","configurationCode":"chess-family","groupMembers":`+members+`}`), nil
	case strings.HasSuffix(req.URL.Path, "/roles"):
		roles := "["
		i := 0
		for id, name := range f.rolesCatalog {
			if i > 0 {
				roles += ","
			}
			roles += `{"memberRoleId":"` + id + `","memberRoleName":"` + name + `"}`
			i++
		}
		roles += "]"
		return jsonResponse(200, `{"data":`+roles+`}`), nil
	}
	return &http.Response{StatusCode: 404, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`)), Request: req}, nil
}

func TestResolveSelfChildFindsGuardian(t *testing.T) {
	transport := &familyGroupRoundTripper{
		groupID: "fam-1",
		members: []struct {
			userID string
			roleID string
		}{
			{userID: "guardian-1", roleID: "role-g"},
			{userID: "child-1", roleID: "role-c"},
		},
		rolesCatalog: map[string]string{"role-g": "guardian", "role-c": "child"},
	}
	h := testMonetizationHandler(transport)

	role, guardianID, err := h.roles.resolveSelf("child-1", "caller-child-token")
	if err != nil {
		t.Fatal(err)
	}
	if role != "child" || guardianID != "guardian-1" {
		t.Fatalf("role=%q guardianID=%q, want child/guardian-1", role, guardianID)
	}
}

func TestResolveSelfGuardianHasNoGuardianID(t *testing.T) {
	transport := &familyGroupRoundTripper{
		groupID: "fam-1",
		members: []struct {
			userID string
			roleID string
		}{
			{userID: "guardian-1", roleID: "role-g"},
			{userID: "child-1", roleID: "role-c"},
		},
		rolesCatalog: map[string]string{"role-g": "guardian", "role-c": "child"},
	}
	h := testMonetizationHandler(transport)

	role, guardianID, err := h.roles.resolveSelf("guardian-1", "caller-guardian-token")
	if err != nil {
		t.Fatal(err)
	}
	if role != "guardian" || guardianID != "" {
		t.Fatalf("role=%q guardianID=%q, want guardian/empty", role, guardianID)
	}
}

func TestResolveSelfNotInAnyFamily(t *testing.T) {
	transport := &familyGroupRoundTripper{} // groupID == "" → 404 on me/groups
	h := testMonetizationHandler(transport)

	role, guardianID, err := h.roles.resolveSelf("lonely-user", "caller-token")
	if err != nil {
		t.Fatal(err)
	}
	if role != "" || guardianID != "" {
		t.Fatalf("role=%q guardianID=%q, want both empty", role, guardianID)
	}
}

func TestIsGuardianOfWithinOwnGroupTrueForOwnChild(t *testing.T) {
	transport := &familyGroupRoundTripper{
		groupID: "fam-1",
		members: []struct {
			userID string
			roleID string
		}{
			{userID: "guardian-1", roleID: "role-g"},
			{userID: "child-1", roleID: "role-c"},
		},
		rolesCatalog: map[string]string{"role-g": "guardian", "role-c": "child"},
	}
	h := testMonetizationHandler(transport)

	ok, err := h.roles.isGuardianOfWithinOwnGroup("guardian-1", "caller-guardian-token", "child-1")
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected guardian-1 to be recognized as child-1's guardian")
	}
}

func TestIsGuardianOfWithinOwnGroupFalseForStranger(t *testing.T) {
	transport := &familyGroupRoundTripper{
		groupID: "fam-1",
		members: []struct {
			userID string
			roleID string
		}{
			{userID: "guardian-1", roleID: "role-g"},
			{userID: "child-1", roleID: "role-c"},
		},
		rolesCatalog: map[string]string{"role-g": "guardian", "role-c": "child"},
	}
	h := testMonetizationHandler(transport)

	// guardian-1 tries to claim a child who isn't in their own group.
	ok, err := h.roles.isGuardianOfWithinOwnGroup("guardian-1", "caller-guardian-token", "some-other-child")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("expected a user outside the caller's own family group to be rejected")
	}
}

func TestIsGuardianOfWithinOwnGroupFalseForChildCaller(t *testing.T) {
	transport := &familyGroupRoundTripper{
		groupID: "fam-1",
		members: []struct {
			userID string
			roleID string
		}{
			{userID: "guardian-1", roleID: "role-g"},
			{userID: "child-1", roleID: "role-c"},
			{userID: "child-2", roleID: "role-c"},
		},
		rolesCatalog: map[string]string{"role-g": "guardian", "role-c": "child"},
	}
	h := testMonetizationHandler(transport)

	// A child caller must never be treated as anyone's guardian, even if
	// another child is a fellow member of the same group.
	ok, err := h.roles.isGuardianOfWithinOwnGroup("child-1", "caller-child-token", "child-2")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("expected a child caller to never be recognized as a guardian")
	}
}
