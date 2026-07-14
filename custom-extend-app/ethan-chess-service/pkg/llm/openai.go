package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// openAIProvider uses the Responses API for OpenAI by default and retains a
// Chat Completions compatibility path for local OpenAI-shaped servers.
type openAIProvider struct {
	cfg          Config
	client       *http.Client
	responsesAPI bool
	officialAPI  bool
}

func newOpenAI(cfg Config) (*openAIProvider, error) {
	if cfg.BaseURL == "" {
		cfg.BaseURL = "https://api.openai.com/v1"
	}
	if cfg.Model == "" {
		cfg.Model = "gpt-5.6-terra"
	}
	mode := strings.ToLower(strings.TrimSpace(cfg.APIMode))
	if mode == "" {
		mode = "auto"
	}
	if mode != "auto" && mode != "responses" && mode != "chat" {
		return nil, fmt.Errorf("openai: invalid LLM_API_MODE %q (use auto, responses, or chat)", mode)
	}
	parsedBase, err := url.Parse(cfg.BaseURL)
	if err != nil || (parsedBase.Scheme != "http" && parsedBase.Scheme != "https") || parsedBase.Host == "" {
		return nil, fmt.Errorf("openai: invalid LLM_BASE_URL %q", cfg.BaseURL)
	}
	official := strings.EqualFold(parsedBase.Hostname(), "api.openai.com")
	responses := mode == "responses" || (mode == "auto" && official)
	if responses && !validReasoningEffort(cfg.Reasoning) {
		return nil, fmt.Errorf("openai: invalid LLM_REASONING_EFFORT %q", cfg.Reasoning)
	}
	return &openAIProvider{
		cfg: cfg, responsesAPI: responses, officialAPI: official,
		client: &http.Client{Timeout: 180 * time.Second},
	}, nil
}

func (p *openAIProvider) Name() string  { return "openai" }
func (p *openAIProvider) Model() string { return p.cfg.Model }

func (p *openAIProvider) Complete(ctx context.Context, req Request) (string, error) {
	if p.responsesAPI {
		return p.completeResponses(ctx, req)
	}
	return p.completeChat(ctx, req)
}

func (p *openAIProvider) completeResponses(ctx context.Context, req Request) (string, error) {
	payload := map[string]any{
		"model":             p.cfg.Model,
		"input":             req.User,
		"max_output_tokens": pickInt(req.MaxTokens, p.cfg.MaxTokens, 2048),
		"store":             false,
	}
	if strings.TrimSpace(req.System) != "" {
		payload["instructions"] = req.System
	}
	if strings.HasPrefix(p.cfg.Model, "gpt-5") || strings.HasPrefix(p.cfg.Model, "o") {
		effort := p.cfg.Reasoning
		if effort == "" {
			effort = "low"
		}
		payload["reasoning"] = map[string]any{"effort": effort}
	}
	if len(req.JSONSchema) > 0 {
		name := req.SchemaName
		if name == "" {
			name = "structured_response"
		}
		payload["text"] = map[string]any{"format": map[string]any{
			"type": "json_schema", "name": name, "strict": true, "schema": req.JSONSchema,
		}}
	}
	raw, status, err := p.post(ctx, "/responses", payload)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		return "", responseError("openai responses", p.cfg.BaseURL, status, raw)
	}
	var out struct {
		Status            string `json:"status"`
		OutputText        string `json:"output_text"`
		IncompleteDetails *struct {
			Reason string `json:"reason"`
		} `json:"incomplete_details"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		Output []struct {
			Type    string `json:"type"`
			Content []struct {
				Type    string `json:"type"`
				Text    string `json:"text"`
				Refusal string `json:"refusal"`
			} `json:"content"`
		} `json:"output"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("openai responses: parse response: %w", err)
	}
	if out.Error != nil && out.Error.Message != "" {
		return "", fmt.Errorf("openai responses: %s", out.Error.Message)
	}
	if out.Status == "incomplete" {
		reason := "unknown"
		if out.IncompleteDetails != nil && out.IncompleteDetails.Reason != "" {
			reason = out.IncompleteDetails.Reason
		}
		return "", fmt.Errorf("openai responses: incomplete response (%s)", reason)
	}
	if out.Status != "" && out.Status != "completed" {
		return "", fmt.Errorf("openai responses: terminal status %q", out.Status)
	}
	if strings.TrimSpace(out.OutputText) != "" {
		return out.OutputText, nil
	}
	var text strings.Builder
	var refusal string
	for _, item := range out.Output {
		if item.Type != "message" {
			continue
		}
		for _, content := range item.Content {
			if content.Type == "output_text" {
				text.WriteString(content.Text)
			} else if content.Type == "refusal" && content.Refusal != "" {
				refusal = content.Refusal
			}
		}
	}
	if strings.TrimSpace(text.String()) == "" {
		if refusal != "" {
			return "", fmt.Errorf("openai responses: model refusal: %s", truncate(refusal, 300))
		}
		return "", fmt.Errorf("openai responses: no output_text content")
	}
	return text.String(), nil
}

func validReasoningEffort(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "none", "minimal", "low", "medium", "high", "xhigh", "max":
		return true
	default:
		return false
	}
}

func (p *openAIProvider) completeChat(ctx context.Context, req Request) (string, error) {
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
	if len(req.JSONSchema) > 0 && p.officialAPI {
		name := req.SchemaName
		if name == "" {
			name = "structured_response"
		}
		payload["response_format"] = map[string]any{
			"type":        "json_schema",
			"json_schema": map[string]any{"name": name, "strict": true, "schema": req.JSONSchema},
		}
	}
	raw, status, err := p.post(ctx, "/chat/completions", payload)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		return "", responseError("openai chat", p.cfg.BaseURL, status, raw)
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("openai chat: parse response: %w", err)
	}
	if len(out.Choices) == 0 || strings.TrimSpace(out.Choices[0].Message.Content) == "" {
		return "", fmt.Errorf("openai chat: empty choices")
	}
	return out.Choices[0].Message.Content, nil
}

func (p *openAIProvider) post(ctx context.Context, path string, payload map[string]any) ([]byte, int, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, 0, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(p.cfg.BaseURL, "/")+path, bytes.NewReader(body))
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

func responseError(kind, baseURL string, status int, raw []byte) error {
	var body struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &body)
	message := body.Error.Message
	if message == "" {
		message = string(raw)
	}
	return fmt.Errorf("%s (%s) returned %d: %s", kind, baseURL, status, truncate(message, 500))
}
