package main

import (
	"path/filepath"
	"testing"
)

func TestBotRosterDefaultsToOneBot(t *testing.T) {
	t.Setenv("BOT_ID", "")
	t.Setenv("BOT_PERSONAS", "")
	t.Setenv("BOTS_DIR", "")
	t.Setenv("BOT_DIR", "")

	r := newBotRosterFromEnv()
	if got := r.ids(); len(got) != 1 || got[0] != "gambit-gus" {
		t.Fatalf("ids = %v, want [gambit-gus]", got)
	}
	if got := r.byID["gambit-gus"].dir; got != filepath.Join("bots", "gambit-gus") {
		t.Errorf("dir = %q", got)
	}
}

func TestBotRosterIncludesDefaultEvenWhenPersonasOmitIt(t *testing.T) {
	t.Setenv("BOT_ID", "gambit-gus")
	t.Setenv("BOT_PERSONAS", "fortress-fiona")
	t.Setenv("BOTS_DIR", "")
	t.Setenv("BOT_DIR", "")

	r := newBotRosterFromEnv()
	// An unqualified request resolves to the default, so it must be a member
	// even when BOT_PERSONAS forgets to list it.
	if !r.hosts("gambit-gus") {
		t.Fatal("default bot missing from roster")
	}
	if got := r.ids(); len(got) != 2 || got[0] != "gambit-gus" || got[1] != "fortress-fiona" {
		t.Fatalf("ids = %v, want [gambit-gus fortress-fiona]", got)
	}
}

func TestBotRosterDeduplicatesAndTrims(t *testing.T) {
	t.Setenv("BOT_ID", "gambit-gus")
	t.Setenv("BOT_PERSONAS", " fortress-fiona , gambit-gus ,, fortress-fiona ")
	t.Setenv("BOTS_DIR", "")
	t.Setenv("BOT_DIR", "")

	if got := newBotRosterFromEnv().ids(); len(got) != 2 {
		t.Fatalf("ids = %v, want 2 unique entries", got)
	}
}

// BOT_DIR overrides only the default bot's directory. Siblings resolve from
// BOTS_DIR, so pointing BOT_DIR at a fixture can't drag the others with it.
func TestBotRosterBotDirOverridesOnlyTheDefault(t *testing.T) {
	t.Setenv("BOT_ID", "gambit-gus")
	t.Setenv("BOT_PERSONAS", "gambit-gus,fortress-fiona")
	t.Setenv("BOTS_DIR", "testdata/bots")
	t.Setenv("BOT_DIR", "/somewhere/else/gus")

	r := newBotRosterFromEnv()
	if got := r.byID["gambit-gus"].dir; got != "/somewhere/else/gus" {
		t.Errorf("default dir = %q", got)
	}
	if got := r.byID["fortress-fiona"].dir; got != filepath.Join("testdata/bots", "fortress-fiona") {
		t.Errorf("sibling dir = %q", got)
	}
}

func TestBotRosterResolve(t *testing.T) {
	t.Setenv("BOT_ID", "gambit-gus")
	t.Setenv("BOT_PERSONAS", "gambit-gus,fortress-fiona")
	t.Setenv("BOTS_DIR", "")
	t.Setenv("BOT_DIR", "")
	r := newBotRosterFromEnv()

	for _, tc := range []struct {
		name, requested, wantID string
		wantOK                  bool
	}{
		{"empty resolves to default", "", "gambit-gus", true},
		{"whitespace resolves to default", "  ", "gambit-gus", true},
		{"named bot", "fortress-fiona", "fortress-fiona", true},
		{"unknown bot is reported, not defaulted", "nemesis-nigel", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			entry, ok := r.resolve(tc.requested)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if ok && entry.id != tc.wantID {
				t.Errorf("id = %q, want %q", entry.id, tc.wantID)
			}
		})
	}
}
