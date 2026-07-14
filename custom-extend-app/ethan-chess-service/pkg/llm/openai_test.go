package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func testResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

func TestOpenAIDefaultUsesResponsesStructuredOutputs(t *testing.T) {
	provider, err := newOpenAI(Config{APIKey: "test-key", APIMode: "auto", Reasoning: "low"})
	if err != nil {
		t.Fatal(err)
	}
	if provider.Model() != "gpt-5.6-terra" {
		t.Fatalf("default model = %q", provider.Model())
	}
	if !provider.responsesAPI {
		t.Fatal("official OpenAI default should use Responses")
	}
	var captured map[string]any
	provider.client = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path != "/v1/responses" {
			t.Fatalf("path = %s, want /v1/responses", req.URL.Path)
		}
		if req.Header.Get("Authorization") != "Bearer test-key" {
			t.Fatalf("missing bearer auth")
		}
		_ = json.NewDecoder(req.Body).Decode(&captured)
		return testResponse(200, `{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"{\"ok\":true}"}]}]}`), nil
	})}

	text, err := provider.Complete(context.Background(), Request{
		System: "system", User: "user", SchemaName: "answer",
		JSONSchema: map[string]any{
			"type": "object", "properties": map[string]any{"ok": map[string]any{"type": "boolean"}},
			"required": []string{"ok"}, "additionalProperties": false,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if text != `{"ok":true}` {
		t.Fatalf("text = %q", text)
	}
	format := captured["text"].(map[string]any)["format"].(map[string]any)
	if format["type"] != "json_schema" || format["strict"] != true || format["name"] != "answer" {
		t.Fatalf("structured output format = %#v", format)
	}
	if _, ok := captured["max_output_tokens"]; !ok {
		t.Fatal("Responses request missing max_output_tokens")
	}
	if captured["store"] != false {
		t.Fatalf("store = %#v, want false", captured["store"])
	}
}

func TestOpenAICustomBaseAutoRetainsChatCompatibility(t *testing.T) {
	provider, err := newOpenAI(Config{BaseURL: "http://local.test/v1", Model: "local-model", APIMode: "auto"})
	if err != nil {
		t.Fatal(err)
	}
	if provider.responsesAPI {
		t.Fatal("custom OpenAI-compatible base should remain on chat in auto mode")
	}
	provider.client = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path != "/v1/chat/completions" {
			t.Fatalf("path = %s", req.URL.Path)
		}
		return testResponse(200, `{"choices":[{"message":{"content":"ok"}}]}`), nil
	})}
	got, err := provider.Complete(context.Background(), Request{User: "hello"})
	if err != nil || got != "ok" {
		t.Fatalf("got %q, err=%v", got, err)
	}
}

func TestOpenAIRejectsUnsafeOrInvalidConfiguration(t *testing.T) {
	if _, err := newOpenAI(Config{BaseURL: "api.openai.com/v1"}); err == nil {
		t.Fatal("base URL without an http(s) scheme was accepted")
	}
	if _, err := newOpenAI(Config{APIMode: "responses", Reasoning: "maximum-ish"}); err == nil {
		t.Fatal("invalid reasoning effort was accepted")
	}
	provider, err := newOpenAI(Config{BaseURL: "https://api.openai.com.attacker.invalid/v1", APIMode: "auto"})
	if err != nil {
		t.Fatal(err)
	}
	if provider.responsesAPI {
		t.Fatal("lookalike hostname was treated as official OpenAI")
	}
}
