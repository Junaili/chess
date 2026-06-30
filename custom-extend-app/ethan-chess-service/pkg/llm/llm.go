// Package llm is a tiny, provider-agnostic text-completion layer so the bot
// trainer can reflect using whatever model the user prefers:
//
//   - Anthropic API          (LLM_PROVIDER=anthropic)
//   - OpenAI / ChatGPT API   (LLM_PROVIDER=openai)
//   - A local model          (LLM_PROVIDER=openai + LLM_BASE_URL=http://localhost:11434/v1
//     — Ollama, LM Studio, llama.cpp, vLLM all speak the
//     OpenAI-compatible chat-completions API)
//
// The interface is deliberately text-in/text-out; structured-output (JSON)
// handling lives in the trainer so it stays portable across models that don't
// support provider-specific JSON modes.
package llm

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Request is one completion call.
type Request struct {
	System      string
	User        string
	Temperature float64
	MaxTokens   int
}

// Provider is any model backend that can complete a prompt.
type Provider interface {
	Name() string
	Model() string
	Complete(ctx context.Context, req Request) (string, error)
}

// Config selects and configures a provider. Everything is overridable by env so
// the same binary works against a cloud API or a local model with no code change.
type Config struct {
	Provider    string // "anthropic" | "openai"
	Model       string
	BaseURL     string // override; for openai this points ChatGPT or a local server
	APIKey      string
	MaxTokens   int
	Temperature float64
}

// FromEnv builds a Config from environment variables, auto-detecting the
// provider from whichever API key is present when LLM_PROVIDER is unset.
func FromEnv() Config {
	cfg := Config{
		Provider:    strings.ToLower(strings.TrimSpace(os.Getenv("LLM_PROVIDER"))),
		Model:       strings.TrimSpace(os.Getenv("LLM_MODEL")),
		BaseURL:     strings.TrimSpace(os.Getenv("LLM_BASE_URL")),
		APIKey:      strings.TrimSpace(os.Getenv("LLM_API_KEY")),
		MaxTokens:   envInt("LLM_MAX_TOKENS", 2048),
		Temperature: envFloat("LLM_TEMPERATURE", 0.4),
	}
	if cfg.Provider == "" {
		switch {
		case os.Getenv("ANTHROPIC_API_KEY") != "":
			cfg.Provider = "anthropic"
		case os.Getenv("OPENAI_API_KEY") != "" || cfg.BaseURL != "":
			cfg.Provider = "openai"
		}
	}
	if cfg.APIKey == "" {
		switch cfg.Provider {
		case "anthropic":
			cfg.APIKey = strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY"))
		case "openai":
			cfg.APIKey = strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
		}
	}
	return cfg
}

// Configured reports whether enough is set to build a working provider.
func (c Config) Configured() bool {
	switch c.Provider {
	case "anthropic":
		return c.APIKey != ""
	case "openai":
		// A cloud key OR a local base URL (local servers often need no key).
		return c.APIKey != "" || c.BaseURL != ""
	default:
		return false
	}
}

// New constructs the selected provider.
func New(cfg Config) (Provider, error) {
	switch cfg.Provider {
	case "anthropic":
		return newAnthropic(cfg)
	case "openai":
		return newOpenAI(cfg)
	case "":
		return nil, fmt.Errorf("no LLM provider configured: set LLM_PROVIDER (anthropic|openai) and a key/base URL")
	default:
		return nil, fmt.Errorf("unknown LLM provider %q (use anthropic or openai)", cfg.Provider)
	}
}

func envInt(key string, def int) int {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envFloat(key string, def float64) float64 {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}
