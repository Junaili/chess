package handler

import (
	"crypto/tls"
	"fmt"
	"log"
	"net/http"
	"net/smtp"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
)

type InviteRequest struct {
	To         string `json:"to"          binding:"required"`
	FromName   string `json:"from_name"   binding:"required"`
	InviteLink string `json:"invite_link" binding:"required"`
}

func SendInvite(c *gin.Context) {
	var req InviteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if !strings.Contains(req.To, "@") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid email address"})
		return
	}

	if err := sendGmail(req); err != nil {
		log.Printf("[email] send failed: %v", err)
		c.JSON(http.StatusBadGateway, gin.H{"error": "email delivery failed"})
		return
	}

	log.Printf("[email] invite sent to %s from %s", req.To, req.FromName)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func sendGmail(req InviteRequest) error {
	from := os.Getenv("GMAIL_USER")
	password := os.Getenv("GMAIL_APP_PW")
	if from == "" || password == "" {
		return fmt.Errorf("GMAIL_USER or GMAIL_APP_PW not set")
	}

	subject := fmt.Sprintf("%s challenged you to a chess game!", req.FromName)
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
</div>`, req.FromName, req.InviteLink, req.FromName)

	message := fmt.Sprintf(
		"From: Chess Game <%s>\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=\"utf-8\"\r\n\r\n%s",
		from, req.To, subject, htmlBody,
	)

	auth := smtp.PlainAuth("", from, password, "smtp.gmail.com")

	tlsCfg := &tls.Config{ServerName: "smtp.gmail.com"}
	conn, err := tls.Dial("tcp", "smtp.gmail.com:465", tlsCfg)
	if err != nil {
		return fmt.Errorf("dial smtp.gmail.com:465: %w", err)
	}
	defer conn.Close()

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
