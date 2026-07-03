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

// openAIProvider speaks the OpenAI chat-completions API. Because Ollama, LM
// Studio, llama.cpp and vLLM all expose the same shape, pointing BaseURL at a
// local server (e.g. http://localhost:11434/v1) runs the trainer fully offline.
type openAIProvider struct {
	cfg    Config
	client *http.Client
}

func newOpenAI(cfg Config) (*openAIProvider, error) {
	if cfg.BaseURL == "" {
		cfg.BaseURL = "https://api.openai.com/v1"
	}
	if cfg.Model == "" {
		cfg.Model = "gpt-4o-mini"
	}
	// API key may legitimately be empty for some local servers.
	return &openAIProvider{cfg: cfg, client: &http.Client{Timeout: 180 * time.Second}}, nil
}

func (p *openAIProvider) Name() string  { return "openai" }
func (p *openAIProvider) Model() string { return p.cfg.Model }

func (p *openAIProvider) Complete(ctx context.Context, req Request) (string, error) {
	messages := []map[string]string{}
	if strings.TrimSpace(req.System) != "" {
		messages = append(messages, map[string]string{"role": "system", "content": req.System})
	}
	messages = append(messages, map[string]string{"role": "user", "content": req.User})

	payload := map[string]any{
		"model":       p.cfg.Model,
		"messages":    messages,
		"temperature": pickFloat(req.Temperature, p.cfg.Temperature, 0.4),
		"max_tokens":  pickInt(req.MaxTokens, p.cfg.MaxTokens, 2048),
	}

	// Newer OpenAI models (gpt-5.x, o-series) reject the legacy params one at a
	// time: max_tokens must become max_completion_tokens, and non-default
	// temperature is unsupported. Older local OpenAI-compatible servers (Ollama,
	// llama.cpp, vLLM) only know the legacy names. Start legacy and adapt on the
	// specific 400s so both families work without configuration.
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		raw, status, err := p.post(ctx, payload)
		if err != nil {
			return "", err
		}
		if status == http.StatusOK {
			var out struct {
				Choices []struct {
					Message struct {
						Content string `json:"content"`
					} `json:"message"`
				} `json:"choices"`
			}
			if err := json.Unmarshal(raw, &out); err != nil {
				return "", fmt.Errorf("openai: parse response: %w", err)
			}
			if len(out.Choices) == 0 {
				return "", fmt.Errorf("openai: empty choices")
			}
			return out.Choices[0].Message.Content, nil
		}

		body := string(raw)
		lastErr = fmt.Errorf("openai (%s) returned %d: %s", p.cfg.BaseURL, status, truncate(body, 500))
		if status != http.StatusBadRequest {
			return "", lastErr
		}
		switch {
		case strings.Contains(body, "max_tokens") && payload["max_tokens"] != nil:
			payload["max_completion_tokens"] = payload["max_tokens"]
			delete(payload, "max_tokens")
		case strings.Contains(body, "temperature") && payload["temperature"] != nil:
			delete(payload, "temperature")
		default:
			return "", lastErr
		}
	}
	return "", lastErr
}

func (p *openAIProvider) post(ctx context.Context, payload map[string]any) ([]byte, int, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, 0, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(p.cfg.BaseURL, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if p.cfg.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+p.cfg.APIKey)
	}
	resp, err := p.client.Do(httpReq)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	return raw, resp.StatusCode, nil
}
