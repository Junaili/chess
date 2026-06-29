package handler

import (
	"crypto/tls"
	"fmt"
	"html"
	"log"
	"mime"
	"net"
	"net/mail"
	"net/smtp"
	"net/url"
	"os"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type InviteRequest struct {
	To         string
	FromName   string
	InviteLink string
}

func SendInviteEmail(req InviteRequest) error {
	if err := ValidateInviteRequest(req); err != nil {
		return err
	}
	if err := sendGmail(req); err != nil {
		log.Printf("[email] send failed: %v", err)
		return fmt.Errorf("email delivery failed: %w", err)
	}
	log.Printf("[email] invite sent")
	return nil
}

func ValidateEmailAddress(value string) error {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 254 || strings.ContainsAny(value, "\r\n") {
		return fmt.Errorf("invalid email address")
	}
	parsed, err := mail.ParseAddress(value)
	if err != nil || !strings.EqualFold(parsed.Address, value) {
		return fmt.Errorf("invalid email address")
	}
	parts := strings.Split(parsed.Address, "@")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return fmt.Errorf("invalid email address")
	}
	return nil
}

func ValidateInviteRequest(req InviteRequest) error {
	if err := ValidateEmailAddress(req.To); err != nil {
		return err
	}
	name := strings.TrimSpace(req.FromName)
	if name == "" || utf8.RuneCountInString(name) > 64 {
		return fmt.Errorf("invalid sender name")
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return fmt.Errorf("invalid sender name")
		}
	}
	if len(req.InviteLink) > 2048 {
		return fmt.Errorf("invite_link is too long")
	}
	parsed, err := url.ParseRequestURI(req.InviteLink)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return fmt.Errorf("invite_link must be an approved https URL")
	}
	if _, ok := allowedInviteHosts()[strings.ToLower(parsed.Hostname())]; !ok {
		return fmt.Errorf("invite_link host is not approved")
	}
	return nil
}

func allowedInviteHosts() map[string]struct{} {
	raw := os.Getenv("ALLOWED_INVITE_HOSTS")
	if strings.TrimSpace(raw) == "" {
		raw = "junaili.github.io"
	}
	hosts := make(map[string]struct{})
	for _, host := range strings.Split(raw, ",") {
		host = strings.ToLower(strings.TrimSpace(host))
		if host != "" {
			hosts[host] = struct{}{}
		}
	}
	return hosts
}

func sendGmail(req InviteRequest) error {
	from := os.Getenv("GMAIL_USER")
	password := os.Getenv("GMAIL_APP_PW")
	if from == "" || password == "" {
		return fmt.Errorf("GMAIL_USER or GMAIL_APP_PW not set")
	}
	if err := ValidateEmailAddress(from); err != nil {
		return fmt.Errorf("GMAIL_USER is invalid")
	}

	// HTML-escape user-controlled strings before embedding in the email body.
	safeName := html.EscapeString(req.FromName)
	safeLink := html.EscapeString(req.InviteLink)

	subject := mime.QEncoding.Encode("utf-8", fmt.Sprintf("%s challenged you to a chess game!", strings.TrimSpace(req.FromName)))
	htmlBody := fmt.Sprintf(`<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px">
  <h2 style="color:#2a1f1a">&#9823; You've been challenged!</h2>
  <p style="font-size:16px;color:#3a2f2a">
    <strong>%s</strong> invited you to play a game of chess.
  </p>
  <a href="%s"
     style="display:inline-block;margin:20px 0;padding:14px 28px;
            background:#c26a3d;color:#fff;border-radius:8px;
            text-decoration:none;font-weight:bold;font-size:16px">
    Join the game &rarr;
  </a>
  <p style="color:#888;font-size:12px;margin-top:24px">
    This link is valid while %s is waiting in the game lobby.
    Open it in a browser to join instantly.
  </p>
</div>`, safeName, safeLink, safeName)

	message := fmt.Sprintf(
		"From: Chess Game <%s>\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=\"utf-8\"\r\n\r\n%s",
		from, req.To, subject, htmlBody,
	)

	auth := smtp.PlainAuth("", from, password, "smtp.gmail.com")

	tlsCfg := &tls.Config{ServerName: "smtp.gmail.com", MinVersion: tls.VersionTLS12}
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	conn, err := tls.DialWithDialer(dialer, "tcp", "smtp.gmail.com:465", tlsCfg)
	if err != nil {
		return fmt.Errorf("dial smtp.gmail.com:465: %w", err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(30 * time.Second)); err != nil {
		return fmt.Errorf("set smtp deadline: %w", err)
	}

	client, err := smtp.NewClient(conn, "smtp.gmail.com")
	if err != nil {
		return fmt.Errorf("smtp client: %w", err)
	}
	defer client.Close()

	if err = client.Auth(auth); err != nil {
		return fmt.Errorf("smtp auth: %w", err)
	}
	if err = client.Mail(from); err != nil {
		return fmt.Errorf("MAIL FROM: %w", err)
	}
	if err = client.Rcpt(req.To); err != nil {
		return fmt.Errorf("RCPT TO: %w", err)
	}

	w, err := client.Data()
	if err != nil {
		return fmt.Errorf("DATA: %w", err)
	}
	if _, err = fmt.Fprint(w, message); err != nil {
		return fmt.Errorf("write body: %w", err)
	}
	return w.Close()
}
