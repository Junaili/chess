package main

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type childAccountRoundTripper func(*http.Request) (*http.Response, error)

func (f childAccountRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestValidateChildAccountRequestAllowsUnderageBirthYear(t *testing.T) {
	payload := childAccountRequest{
		GroupID:   "family-1",
		Nickname:  "Mia",
		BirthYear: 2016,
		Password:  "a-good-password",
	}
	if err := validateChildAccountRequest(payload, time.Date(2026, time.July, 9, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("expected underage child account to be accepted: %v", err)
	}
}

func TestValidateChildAccountRequestRejectsAdultBirthYear(t *testing.T) {
	payload := childAccountRequest{GroupID: "family-1", Nickname: "Mia", BirthYear: 2010, Password: "a-good-password"}
	if err := validateChildAccountRequest(payload, time.Date(2026, time.July, 9, 0, 0, 0, 0, time.UTC)); err == nil {
		t.Fatal("expected adult birth year to be rejected by child flow")
	}
}

func TestCreateAdminUserUsesAdminRouteAndKeepsAgeConsentServerSide(t *testing.T) {
	var request *http.Request
	h := &childAccountHandler{
		agsBaseURL: "https://ags.example",
		namespace:  "test",
		httpClient: &http.Client{Transport: childAccountRoundTripper(func(r *http.Request) (*http.Response, error) {
			request = r
			return &http.Response{
				StatusCode: http.StatusCreated,
				Body:       io.NopCloser(strings.NewReader(`{"userId":"child-123"}`)),
				Header:     make(http.Header),
			}, nil
		})},
	}

	userID, err := h.createAdminUser("s2s-token", "parent+chess-mia-abc123@example.com", "miaabc123", childAccountRequest{
		Nickname:  "Mia",
		BirthYear: 2016,
		Password:  "a-good-password",
	})
	if err != nil || userID != "child-123" {
		t.Fatalf("createAdminUser() = %q, %v", userID, err)
	}
	if request.URL.Path != "/iam/v4/admin/namespaces/test/users" {
		t.Fatalf("unexpected admin route: %s", request.URL.Path)
	}
	body, err := io.ReadAll(request.Body)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	if !strings.Contains(text, `"dateOfBirth":"2016-12-31"`) {
		t.Fatalf("admin request omitted conservative child DOB: %s", text)
	}
	if strings.Contains(text, "reachMinimumAge") {
		t.Fatalf("admin request should not send public-registration age flag: %s", text)
	}
}
