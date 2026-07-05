package handler

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// stubIAM serves the oauth token endpoint plus a canned response for the admin
// email lookup, so LookupEmailInIAM runs against a local server via AB_BASE_URL.
func stubIAM(t *testing.T, status int, body string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/iam/v3/oauth/token" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"access_token":"stub-token","expires_in":3600}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("AB_BASE_URL", srv.URL)
	t.Setenv("AB_CLIENT_ID", "test-client")
	t.Setenv("AB_CLIENT_SECRET", "test-secret")
	t.Setenv("AB_NAMESPACE", "test-ns")
}

func TestLookupEmailInIAM(t *testing.T) {
	cases := []struct {
		name       string
		status     int
		body       string
		wantFound  bool
		wantUserID string
		wantErr    bool
	}{
		{
			name:       "paginated list shape (legacy)",
			status:     200,
			body:       `{"data":[{"userId":"u-123","displayName":"Alice"}],"paging":{}}`,
			wantFound:  true,
			wantUserID: "u-123",
		},
		{
			// The shape IAM returns today: a single bare user object. Parsing
			// only the list shape made every existing user come back found:false
			// and silently broke invite auto-friending.
			name:       "single user object shape (current)",
			status:     200,
			body:       `{"userId":"u-456","displayName":"Bob","emailAddress":"bob@example.com","emailVerified":false}`,
			wantFound:  true,
			wantUserID: "u-456",
		},
		{
			name:      "user not found (404)",
			status:    404,
			body:      `{"errorCode":20008,"errorMessage":"user not found"}`,
			wantFound: false,
		},
		{
			name:      "empty list",
			status:    200,
			body:      `{"data":[],"paging":{}}`,
			wantFound: false,
		},
		{
			name:    "unexpected status",
			status:  500,
			body:    `{"errorMessage":"boom"}`,
			wantErr: true,
		},
		{
			name:    "malformed body",
			status:  200,
			body:    `not-json`,
			wantErr: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stubIAM(t, tc.status, tc.body)
			got, err := LookupEmailInIAM("someone@example.com")
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %+v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.Found != tc.wantFound {
				t.Fatalf("Found = %v, want %v (result %+v)", got.Found, tc.wantFound, got)
			}
			if got.UserID != tc.wantUserID {
				t.Fatalf("UserID = %q, want %q", got.UserID, tc.wantUserID)
			}
		})
	}
}
