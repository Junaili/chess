package handler

import (
	"strings"
	"testing"
)

func TestBuildInviteMessage(t *testing.T) {
	t.Parallel()

	req := InviteRequest{
		To:         "newplayer@example.com",
		FromName:   `Tom & "Jerry"`,
		InviteLink: "https://junaili.github.io/chess/?room=abc123",
	}
	msg := buildInviteMessage("ethan@gmail.com", req)

	mustContain := map[string]string{
		"From display name":   `From: "Ethan's Chess" <ethan@gmail.com>`,
		"recipient":           "To: newplayer@example.com",
		"date header":         "Date: ",
		"message id":          "Message-ID: <",
		"multipart type":      "Content-Type: multipart/alternative; boundary=",
		"plain text part":     `Content-Type: text/plain; charset="utf-8"`,
		"html part":           `Content-Type: text/html; charset="utf-8"`,
		"invite link":         req.InviteLink,
		"html-escaped name":   `Tom &amp; &#34;Jerry&#34;`,
		"cta":                 "Join the game",
		"brand":               "Ethan's Chess",
		"fallback link label": "Copy and paste this link",
	}
	for label, want := range mustContain {
		if !strings.Contains(msg, want) {
			t.Errorf("message missing %s: expected to contain %q", label, want)
		}
	}

	// The raw (unescaped) name must not leak into the HTML body. It is allowed in
	// the plain-text part, so check only the HTML section.
	_, htmlPart, ok := strings.Cut(msg, `Content-Type: text/html`)
	if !ok {
		t.Fatal("no html part found")
	}
	if strings.Contains(htmlPart, `Tom & "Jerry"`) {
		t.Error("raw unescaped sender name leaked into the HTML body")
	}

	// A multipart message must terminate with the closing boundary marker.
	if !strings.Contains(msg, "--\r\n") || !strings.HasSuffix(strings.TrimRight(msg, "\r\n"), "--") {
		t.Error("message does not end with a closing MIME boundary")
	}
}

func TestBuildWelcomeMessage(t *testing.T) {
	t.Parallel()

	req := WelcomeRequest{To: "newplayer@example.com", DisplayName: `Ann & "Lee"`}
	msg := buildWelcomeMessage("ethan@gmail.com", req)

	mustContain := map[string]string{
		"From display name": `From: "Ethan's Chess" <ethan@gmail.com>`,
		"recipient":         "To: newplayer@example.com",
		"multipart type":    "Content-Type: multipart/alternative; boundary=",
		"plain text part":   `Content-Type: text/plain; charset="utf-8"`,
		"html part":         `Content-Type: text/html; charset="utf-8"`,
		"subject":           "Welcome to Ethan",
		"html-escaped name": `Welcome, Ann &amp; &#34;Lee&#34;!`,
		"app link":          "https://junaili.github.io/chess/",
		"cta":               "Play your first game",
	}
	for label, want := range mustContain {
		if !strings.Contains(msg, want) {
			t.Errorf("welcome message missing %s: expected to contain %q", label, want)
		}
	}

	// Raw unescaped name must not leak into the HTML body.
	_, htmlPart, ok := strings.Cut(msg, `Content-Type: text/html`)
	if !ok {
		t.Fatal("no html part found")
	}
	if strings.Contains(htmlPart, `Ann & "Lee"`) {
		t.Error("raw unescaped display name leaked into the HTML body")
	}

	// Empty display name falls back to a generic greeting, not blank.
	generic := buildWelcomeMessage("ethan@gmail.com", WelcomeRequest{To: "x@example.com"})
	if !strings.Contains(generic, "Welcome, there!") {
		t.Error("empty display name should fall back to 'there'")
	}
}

func TestValidateWelcomeRequest(t *testing.T) {
	t.Parallel()

	if err := ValidateWelcomeRequest(WelcomeRequest{To: "ok@example.com", DisplayName: "Ethan"}); err != nil {
		t.Fatalf("expected valid welcome request: %v", err)
	}
	// Empty display name is allowed.
	if err := ValidateWelcomeRequest(WelcomeRequest{To: "ok@example.com"}); err != nil {
		t.Fatalf("empty display name should be allowed: %v", err)
	}
	bad := map[string]WelcomeRequest{
		"bad email":       {To: "not-an-email", DisplayName: "Ethan"},
		"header in email": {To: "a@example.com\r\nBcc: x@example.com", DisplayName: "Ethan"},
		"control in name": {To: "ok@example.com", DisplayName: "Ethan\r\nReply-To: x@example.com"},
	}
	for name, req := range bad {
		if err := ValidateWelcomeRequest(req); err == nil {
			t.Errorf("%s: expected rejection", name)
		}
	}
}

func TestValidateEmailAddress(t *testing.T) {
	t.Parallel()

	for _, email := range []string{
		"player@example.com",
		"player@example.com\r\nBcc: attacker@example.com",
		"Player <player@example.com>",
		"not-an-email",
		"@example.com",
	} {
		email := email
		t.Run(email, func(t *testing.T) {
			t.Parallel()
			err := ValidateEmailAddress(email)
			if email == "player@example.com" && err != nil {
				t.Fatalf("expected valid email, got %v", err)
			}
			if email != "player@example.com" && err == nil {
				t.Fatal("expected invalid email")
			}
		})
	}
}

func TestValidateInviteRequest(t *testing.T) {
	t.Setenv("ALLOWED_INVITE_HOSTS", "junaili.github.io")

	valid := InviteRequest{
		To:         "player@example.com",
		FromName:   "Ethan",
		InviteLink: "https://junaili.github.io/chess/?room=abc",
	}
	if err := ValidateInviteRequest(valid); err != nil {
		t.Fatalf("expected valid invite: %v", err)
	}

	tests := map[string]InviteRequest{
		"unapproved host": {
			To: "player@example.com", FromName: "Ethan",
			InviteLink: "https://evil.example/chess/?room=abc",
		},
		"javascript scheme": {
			To: "player@example.com", FromName: "Ethan",
			InviteLink: "javascript:alert(1)",
		},
		"header injection": {
			To: "player@example.com\r\nBcc: attacker@example.com", FromName: "Ethan",
			InviteLink: "https://junaili.github.io/chess/",
		},
		"control in name": {
			To: "player@example.com", FromName: "Ethan\r\nReply-To: attacker@example.com",
			InviteLink: "https://junaili.github.io/chess/",
		},
	}
	for name, req := range tests {
		req := req
		t.Run(name, func(t *testing.T) {
			if err := ValidateInviteRequest(req); err == nil {
				t.Fatal("expected request to be rejected")
			}
		})
	}
}
