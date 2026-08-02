package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// writeBotDir stages a personality the way the AMS artifact does.
func writeBotDir(t *testing.T, root, dirName, botID, displayName string) string {
	t.Helper()
	dir := filepath.Join(root, dirName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	files := map[string]string{
		"persona.md": "# " + displayName + "\n",
		"style.json": `{"name":"` + displayName + `"}`,
		"brain.json": `{"bot_id":"` + botID + `","version":3,"lessons":[]}`,
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	return dir
}

func TestDiscoverPersonaDirsFindsOnlyPersonalities(t *testing.T) {
	root := t.TempDir()
	writeBotDir(t, root, "gambit-gus", "gambit-gus", "Gambit Gus")
	writeBotDir(t, root, "fortress-fiona", "fortress-fiona", "Fortress Fiona")

	// Staged alongside the bots but not personalities.
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("notes"), 0o644); err != nil {
		t.Fatalf("write README: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(root, "selfplay"), 0o755); err != nil {
		t.Fatalf("mkdir selfplay: %v", err)
	}

	got, err := discoverPersonaDirs(root)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if want := []string{"fortress-fiona", "gambit-gus"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("discovered %v, want %v", got, want)
	}
}

func TestDiscoverPersonaDirsToleratesMissingRoot(t *testing.T) {
	got, err := discoverPersonaDirs(filepath.Join(t.TempDir(), "absent"))
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("discovered %v", got)
	}
}

func TestLoadRosterLoadsEveryHostedPersonality(t *testing.T) {
	root := t.TempDir()
	writeBotDir(t, root, "gambit-gus", "gambit-gus", "Gambit Gus")
	writeBotDir(t, root, "fortress-fiona", "fortress-fiona", "Fortress Fiona")

	discovered, err := discoverPersonaDirs(root)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	roster, err := resolveBotRoster(root, discovered, "", "", "", noEnv)
	if err != nil {
		t.Fatalf("resolve roster: %v", err)
	}

	bots, err := loadRoster(roster)
	if err != nil {
		t.Fatalf("load roster: %v", err)
	}
	if len(bots) != 2 {
		t.Fatalf("loaded %d bots", len(bots))
	}
	if bots["fortress-fiona"].Name != "Fortress Fiona" {
		t.Fatalf("fiona = %#v", bots["fortress-fiona"])
	}
}

// A directory holding someone else's brain would make the DS answer as the wrong
// personality, so loading must fail rather than serve it.
func TestLoadRosterRejectsMismatchedBrain(t *testing.T) {
	root := t.TempDir()
	writeBotDir(t, root, "gambit-gus", "gambit-gus", "Gambit Gus")
	writeBotDir(t, root, "fortress-fiona", "gambit-gus", "Gambit Gus")

	roster, err := resolveBotRoster(root, []string{"fortress-fiona", "gambit-gus"}, "", "", "", noEnv)
	if err != nil {
		t.Fatalf("resolve roster: %v", err)
	}
	if _, err := loadRoster(roster); err == nil {
		t.Fatal("expected an error")
	}
}

func TestLoadRosterFailsWhenAPersonalityIsMissing(t *testing.T) {
	root := t.TempDir()
	writeBotDir(t, root, "gambit-gus", "gambit-gus", "Gambit Gus")

	roster, err := resolveBotRoster(root, []string{"fortress-fiona", "gambit-gus"}, "", "", "", noEnv)
	if err != nil {
		t.Fatalf("resolve roster: %v", err)
	}
	if _, err := loadRoster(roster); err == nil {
		t.Fatal("expected an error")
	}
}
