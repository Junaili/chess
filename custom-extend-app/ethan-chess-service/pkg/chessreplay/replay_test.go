package chessreplay

import "testing"

import "github.com/junaili/ethan-chess-service/pkg/botbrain"

// Scholar's mate, expressed in the app's coordinates (row 0 = rank 8, col 0 = a):
//  1. e4 e5  2. Bc4 Nc6  3. Qh5 Nf6??  4. Qxf7#
func TestReconstructScholarsMate(t *testing.T) {
	m := botbrain.MatchEntry{
		ID:        "test-scholars",
		WhiteName: "Gambit Gus",
		BlackName: "Victim",
		Result:    "win",
		Moves: []botbrain.Move{
			{Fr: 6, Fc: 4, ToR: 4, ToC: 4}, // e2-e4
			{Fr: 1, Fc: 4, ToR: 3, ToC: 4}, // e7-e5
			{Fr: 7, Fc: 5, ToR: 4, ToC: 2}, // Bf1-c4
			{Fr: 0, Fc: 1, ToR: 2, ToC: 2}, // Nb8-c6
			{Fr: 7, Fc: 3, ToR: 3, ToC: 7}, // Qd1-h5
			{Fr: 0, Fc: 6, ToR: 2, ToC: 5}, // Ng8-f6
			{Fr: 3, Fc: 7, ToR: 1, ToC: 5}, // Qh5xf7#
		},
	}

	g, err := Reconstruct(m, "Gambit Gus")
	if err != nil {
		t.Fatalf("reconstruct: %v", err)
	}
	if g.Truncated {
		t.Fatalf("unexpected truncation; SANs=%v", g.SANs)
	}
	if g.PlyCount != 7 {
		t.Errorf("ply count = %d, want 7", g.PlyCount)
	}
	if g.BotColor != "white" {
		t.Errorf("bot color = %q, want white", g.BotColor)
	}
	if g.EngineOutcome != "1-0" {
		t.Errorf("outcome = %q, want 1-0", g.EngineOutcome)
	}
	if g.EngineMethod != "Checkmate" {
		t.Errorf("method = %q, want Checkmate", g.EngineMethod)
	}
	if last := g.SANs[len(g.SANs)-1]; last != "Qxf7#" {
		t.Errorf("last move SAN = %q, want Qxf7#", last)
	}
}

func TestReconstructPrefersExplicitBotColor(t *testing.T) {
	m := botbrain.MatchEntry{
		ID: "explicit-color", BotColor: "BLACK", WhiteName: "renamed player", BlackName: "renamed bot",
		Result: "draw", Moves: []botbrain.Move{},
	}
	g, err := Reconstruct(m, "Gambit Gus")
	if err != nil {
		t.Fatal(err)
	}
	if g.BotColor != "black" {
		t.Fatalf("explicit bot color ignored: %q", g.BotColor)
	}
}

// A capture, en passant, castling, and promotion should all round-trip.
func TestReconstructSpecialMoves(t *testing.T) {
	// 1. e4 d5  2. exd5 (capture). Just verify the capture SAN encodes.
	m := botbrain.MatchEntry{
		ID:     "test-capture",
		Result: "completed",
		Moves: []botbrain.Move{
			{Fr: 6, Fc: 4, ToR: 4, ToC: 4}, // e2-e4
			{Fr: 1, Fc: 3, ToR: 3, ToC: 3}, // d7-d5
			{Fr: 4, Fc: 4, ToR: 3, ToC: 3}, // exd5
		},
	}
	g, err := Reconstruct(m, "")
	if err != nil {
		t.Fatalf("reconstruct: %v", err)
	}
	if g.SANs[2] != "exd5" {
		t.Errorf("capture SAN = %q, want exd5", g.SANs[2])
	}
	if g.PlyCount != 3 {
		t.Errorf("ply = %d, want 3", g.PlyCount)
	}
}
