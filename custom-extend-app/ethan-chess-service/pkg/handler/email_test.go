package handler

import "testing"

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
