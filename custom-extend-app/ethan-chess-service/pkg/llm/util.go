package llm

import "context"

func pickInt(vals ...int) int {
	for _, v := range vals {
		if v > 0 {
			return v
		}
	}
	return 0
}

func pickFloat(vals ...float64) float64 {
	for _, v := range vals {
		if v > 0 {
			return v
		}
	}
	return 0
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// FakeProvider is a deterministic in-memory provider for tests and dry-runs.
// It returns Response and records the last request it received.
type FakeProvider struct {
	Response string
	LastReq  Request
}

func (f *FakeProvider) Name() string  { return "fake" }
func (f *FakeProvider) Model() string { return "fake" }

func (f *FakeProvider) Complete(_ context.Context, req Request) (string, error) {
	f.LastReq = req
	return f.Response, nil
}
