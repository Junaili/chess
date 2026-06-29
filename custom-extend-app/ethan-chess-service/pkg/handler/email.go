package handler

import (
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
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

// buildInviteMessage assembles the full RFC 5322 message for an invite email as
// a multipart/alternative (plain-text + HTML) payload. Sending both parts is
// better for deliverability and for clients that don't render HTML. All
// user-controlled fields are already validated by ValidateInviteRequest (no
// CR/LF, approved https link, bounded length); the HTML part additionally
// escapes them, and headers only embed server-controlled values plus the
// validated recipient.
func buildInviteMessage(from string, req InviteRequest) string {
	name := strings.TrimSpace(req.FromName)
	link := strings.TrimSpace(req.InviteLink)
	safeName := html.EscapeString(name)
	safeLink := html.EscapeString(link)

	subject := mime.QEncoding.Encode("utf-8", fmt.Sprintf("%s challenged you to a game of chess", name))
	preheader := fmt.Sprintf("%s is waiting at the board — jump in, it's free and runs right in your browser.", name)

	textBody := fmt.Sprintf(`You've been challenged!

%s invited you to play a game of chess on Ethan's Chess.

It's free, runs right in your browser, and you can chat and even
video-call your opponent while you play -- no download, no sign-up
required to start.

Join the game:
%s

This link works while %s is waiting in the game lobby, so hop in soon.

-- Ethan's Chess
`, name, link, name)

	// Table-based layout with inline styles for broad email-client support.
	// The preheader span sets the inbox preview text, then is hidden visually.
	htmlBody := fmt.Sprintf(`<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4ece3;">
  <span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">%s</span>
  <table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="background:#f4ece3;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #ecdfd2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <tr><td style="background:#2a1f1a;padding:22px 28px;">
          <span style="font-size:18px;font-weight:700;color:#f4ece3;letter-spacing:.2px;">&#9823; Ethan's Chess</span>
        </td></tr>
        <tr><td style="padding:36px 28px 8px 28px;">
          <h1 style="margin:0 0 14px 0;font-size:24px;line-height:1.25;color:#2a1f1a;">%s challenged you to a game of chess</h1>
          <p style="margin:0 0 18px 0;font-size:16px;line-height:1.6;color:#4a3f38;">
            They're waiting for you at the board. Play a real-time match right in your browser &mdash;
            chat and even video-call while you play. It's <strong>free</strong>, with no download
            and nothing to install to get started.
          </p>
        </td></tr>
        <tr><td align="center" style="padding:10px 28px 8px 28px;">
          <a href="%s" style="display:inline-block;padding:15px 34px;background:#c26a3d;color:#ffffff;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;">
            Join the game &rarr;
          </a>
        </td></tr>
        <tr><td style="padding:14px 28px 4px 28px;">
          <p style="margin:0;font-size:13px;line-height:1.5;color:#8a7d73;">
            Button not working? Copy and paste this link into your browser:<br>
            <a href="%s" style="color:#c26a3d;word-break:break-all;">%s</a>
          </p>
        </td></tr>
        <tr><td style="padding:18px 28px 32px 28px;">
          <p style="margin:0;font-size:12px;line-height:1.5;color:#a89c92;">
            This link works while %s is waiting in the game lobby, so hop in soon.
            You received this because %s invited you to Ethan's Chess.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`, html.EscapeString(preheader), safeName, safeLink, safeLink, safeLink, safeName, safeName)

	boundary := "ethanchess_" + randomToken(16)
	domain := "ethanschess.invite"
	if at := strings.LastIndex(from, "@"); at >= 0 && at+1 < len(from) {
		domain = from[at+1:]
	}
	messageID := fmt.Sprintf("<%s.%d@%s>", randomToken(12), time.Now().UnixNano(), domain)

	var b strings.Builder
	fmt.Fprintf(&b, "From: \"Ethan's Chess\" <%s>\r\n", from)
	fmt.Fprintf(&b, "To: %s\r\n", req.To)
	fmt.Fprintf(&b, "Subject: %s\r\n", subject)
	fmt.Fprintf(&b, "Date: %s\r\n", time.Now().Format(time.RFC1123Z))
	fmt.Fprintf(&b, "Message-ID: %s\r\n", messageID)
	b.WriteString("MIME-Version: 1.0\r\n")
	fmt.Fprintf(&b, "Content-Type: multipart/alternative; boundary=\"%s\"\r\n\r\n", boundary)

	fmt.Fprintf(&b, "--%s\r\n", boundary)
	b.WriteString("Content-Type: text/plain; charset=\"utf-8\"\r\n")
	b.WriteString("Content-Transfer-Encoding: 8bit\r\n\r\n")
	b.WriteString(textBody)
	b.WriteString("\r\n")

	fmt.Fprintf(&b, "--%s\r\n", boundary)
	b.WriteString("Content-Type: text/html; charset=\"utf-8\"\r\n")
	b.WriteString("Content-Transfer-Encoding: 8bit\r\n\r\n")
	b.WriteString(htmlBody)
	b.WriteString("\r\n")

	fmt.Fprintf(&b, "--%s--\r\n", boundary)
	return b.String()
}

// randomToken returns n random bytes hex-encoded, used for MIME boundaries and
// Message-IDs. Falls back to a timestamp if the system RNG is unavailable.
func randomToken(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
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

	message := buildInviteMessage(from, req)

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
