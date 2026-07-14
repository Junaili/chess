package botbrain

import "testing"

func TestMarkProcessedIsIdempotentCachedAndBounded(t *testing.T) {
	brain := &Brain{}
	brain.MarkProcessed("a", "a", "b")
	if len(brain.ProcessedMatchIDs) != 2 || !brain.AlreadyProcessed("a") || !brain.AlreadyProcessed("b") {
		t.Fatalf("processed ids = %#v", brain.ProcessedMatchIDs)
	}
	for i := 0; i < processedMatchIDCap+20; i++ {
		brain.MarkProcessed(string(rune(0x1000 + i)))
	}
	if len(brain.ProcessedMatchIDs) != processedMatchIDCap {
		t.Fatalf("processed id cap = %d, got %d", processedMatchIDCap, len(brain.ProcessedMatchIDs))
	}
	if brain.AlreadyProcessed("a") {
		t.Fatal("old id should have been pruned with the bounded tail")
	}
}
