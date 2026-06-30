package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type anthropicProvider struct {
	cfg    Config
	client *http.Client
}

func newAnthropic(cfg Config) (*anthropicProvider, error) {
	if cfg.APIKey == "" {
		return nil, fmt.Errorf("anthropic: missing API key (set ANTHROPIC_API_KEY or LLM_API_KEY)")
	}
	if cfg.Model == "" {
		cfg.Model = "claude-sonnet-4-6"
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = "https://api.anthropic.com"
	}
	return &anthropicProvider{cfg: cfg, client: &http.Client{Timeout: 120 * time.Second}}, nil
}

func (p *anthropicProvider) Name() string  { return "anthropic" }
func (p *anthropicProvider) Model() string { return p.cfg.Model }

func (p *anthropicProvider) Complete(ctx context.Context, req Request) (string, error) {
	payload := map[string]any{
		"model":       p.cfg.Model,
		"max_tokens":  pickInt(req.MaxTokens, p.cfg.MaxTokens, 2048),
		"temperature": pickFloat(req.Temperature, p.cfg.Temperature, 0.4),
		"system":      req.System,
		"messages": []map[string]string{
			{"role": "user", "content": req.User},
		},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(p.cfg.BaseURL, "/")+"/v1/messages", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", p.cfg.APIKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")

	resp, err := p.client.Do(httpReq)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("anthropic returned %d: %s", resp.StatusCode, truncate(string(raw), 500))
	}

	var out struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("anthropic: parse response: %w", err)
	}
	var sb strings.Builder
	for _, c := range out.Content {
		if c.Type == "text" {
			sb.WriteString(c.Text)
		}
	}
	return sb.String(), nil
}
