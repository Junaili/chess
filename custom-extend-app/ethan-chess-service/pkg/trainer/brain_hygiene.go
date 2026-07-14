package trainer

import (
	"sort"
	"strings"
	"unicode"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
)

const (
	maxOpeningMemories  = 500
	maxOpponentMemories = 500
	maxJournalEntries   = 60
)

// IsTrainableMatch is the shared admission rule for scheduled and local
// trainers. Invalid/test rows are marked processed by callers so they cannot
// poison every later run.
func IsTrainableMatch(match botbrain.MatchEntry) bool {
	id := strings.TrimSpace(match.ID)
	lowerID := strings.ToLower(id)
	if id == "" || strings.Contains(lowerID, "synthetic") || strings.Contains(lowerID, "train-test") {
		return false
	}
	if len(match.Moves) < 4 || len(match.Moves) > 1024 {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(match.Result)) {
	case "win", "loss", "draw":
		return true
	default:
		return false
	}
}

// NormalizeBrain repairs legacy data shapes deterministically before a new
// training commit: name-keyed dossiers are merged into stable user IDs,
// synthetic test journals are removed, and near-duplicate lessons reinforce a
// single memory instead of filling the public list with paraphrases.
func NormalizeBrain(brain *botbrain.Brain, history []botbrain.MatchEntry) {
	brain.MarkProcessed() // also bounds oversized legacy processed-ID arrays
	if brain.OpeningBook == nil {
		brain.OpeningBook = map[string]*botbrain.OpeningStat{}
	}
	if brain.OpponentDossiers == nil {
		brain.OpponentDossiers = map[string]*botbrain.OpponentDossier{}
	}
	nameIDs := map[string]map[string]bool{}
	historyByID := map[string]botbrain.MatchEntry{}
	for _, match := range history {
		if match.ID != "" {
			historyByID[match.ID] = match
		}
		name := strings.ToLower(strings.TrimSpace(match.OpponentName))
		if name == "" || match.OpponentUserID == "" {
			continue
		}
		if nameIDs[name] == nil {
			nameIDs[name] = map[string]bool{}
		}
		nameIDs[name][match.OpponentUserID] = true
	}
	for key, dossier := range brain.OpponentDossiers {
		if dossier == nil {
			delete(brain.OpponentDossiers, key)
			continue
		}
		userID := strings.TrimSpace(dossier.OpponentUserID)
		if userID == "" {
			ids := nameIDs[strings.ToLower(strings.TrimSpace(dossier.OpponentName))]
			if len(ids) != 1 {
				continue // an ambiguous display name must never be assigned to a user
			}
			for id := range ids {
				userID = id
			}
		}
		if key == userID {
			dossier.OpponentUserID = userID
			continue
		}
		target := brain.OpponentDossiers[userID]
		if target == nil {
			target = &botbrain.OpponentDossier{OpponentUserID: userID, OpponentName: dossier.OpponentName}
			brain.OpponentDossiers[userID] = target
		}
		if dossier.UpdatedAt >= target.UpdatedAt && dossier.Notes != "" {
			target.Notes = dossier.Notes
		}
		if target.OpponentName == "" {
			target.OpponentName = dossier.OpponentName
		}
		if dossier.UpdatedAt > target.UpdatedAt {
			target.UpdatedAt = dossier.UpdatedAt
		}
		if dossier.GamesPlayed > target.GamesPlayed {
			target.GamesPlayed = dossier.GamesPlayed
		}
		delete(brain.OpponentDossiers, key)
	}

	var journal []botbrain.JournalEntry
	seenJournal := map[string]bool{}
	for _, entry := range brain.TrainingJournal {
		lower := strings.ToLower(entry.Text + " " + entry.ID)
		if strings.Contains(lower, "synthetic-train-test") || strings.Contains(lower, "synthetic-test") {
			continue
		}
		key := entry.ID
		if key == "" {
			key = entry.Date + "\x00" + entry.Text
		}
		if seenJournal[key] {
			continue
		}
		seenJournal[key] = true
		journal = append(journal, entry)
	}
	brain.TrainingJournal = journal
	if len(brain.TrainingJournal) > maxJournalEntries {
		brain.TrainingJournal = append([]botbrain.JournalEntry(nil), brain.TrainingJournal[len(brain.TrainingJournal)-maxJournalEntries:]...)
	}

	var lessons []botbrain.Lesson
	for _, lesson := range brain.Lessons {
		if strings.TrimSpace(lesson.Text) == "" {
			continue
		}
		origin := strings.ToLower(lesson.FromGame)
		if strings.Contains(origin, "synthetic") || strings.Contains(origin, "train-test") {
			continue
		}
		if match, ok := historyByID[lesson.FromGame]; ok && reflectionContainsIdentity(lesson.Text, GamePair{Entry: match}) {
			continue
		}
		lesson.Tags = normalizeLessonTags(lesson.Tags)
		merged := false
		for i := range lessons {
			if lessonSimilarity(lessons[i].Text, lesson.Text) < 0.72 {
				continue
			}
			lessons[i].Weight += maxFloat(lesson.Weight, 0.25)
			if lesson.LearnedAt > lessons[i].LearnedAt {
				lessons[i].LearnedAt = lesson.LearnedAt
			}
			merged = true
			break
		}
		if !merged {
			if lesson.Weight <= 0 {
				lesson.Weight = 1
			}
			lessons = append(lessons, lesson)
		}
	}
	sort.SliceStable(lessons, func(i, j int) bool {
		if lessons[i].Weight != lessons[j].Weight {
			return lessons[i].Weight > lessons[j].Weight
		}
		return lessons[i].LearnedAt > lessons[j].LearnedAt
	})
	brain.Lessons = lessons
	if len(brain.Lessons) > maxLessons {
		brain.Lessons = append([]botbrain.Lesson(nil), brain.Lessons[:maxLessons]...)
	}
	pruneOpeningMemories(brain.OpeningBook)
	pruneOpponentMemories(brain.OpponentDossiers)
}

func pruneOpeningMemories(openings map[string]*botbrain.OpeningStat) {
	type ranked struct {
		key    string
		played int
	}
	items := make([]ranked, 0, len(openings))
	for key, opening := range openings {
		if opening == nil {
			delete(openings, key)
			continue
		}
		items = append(items, ranked{key: key, played: opening.Played})
	}
	if len(items) <= maxOpeningMemories {
		return
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].played != items[j].played {
			return items[i].played > items[j].played
		}
		return items[i].key < items[j].key
	})
	for _, item := range items[maxOpeningMemories:] {
		delete(openings, item.key)
	}
}

func pruneOpponentMemories(dossiers map[string]*botbrain.OpponentDossier) {
	type ranked struct {
		key       string
		updatedAt string
		games     int
	}
	items := make([]ranked, 0, len(dossiers))
	for key, dossier := range dossiers {
		if dossier == nil {
			delete(dossiers, key)
			continue
		}
		items = append(items, ranked{key: key, updatedAt: dossier.UpdatedAt, games: dossier.GamesPlayed})
	}
	if len(items) <= maxOpponentMemories {
		return
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].updatedAt != items[j].updatedAt {
			return items[i].updatedAt > items[j].updatedAt
		}
		if items[i].games != items[j].games {
			return items[i].games > items[j].games
		}
		return items[i].key < items[j].key
	})
	for _, item := range items[maxOpponentMemories:] {
		delete(dossiers, item.key)
	}
}

var lessonStopWords = map[string]bool{
	"a": true, "an": true, "and": true, "the": true, "to": true, "of": true,
	"in": true, "on": true, "for": true, "my": true, "your": true, "with": true,
	"before": true, "after": true, "when": true, "should": true, "must": true,
}

func lessonTokens(text string) map[string]bool {
	words := strings.FieldsFunc(strings.ToLower(text), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsNumber(r) })
	out := map[string]bool{}
	for _, word := range words {
		word = strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(word, "ing"), "ed"), "s")
		if len(word) < 3 || lessonStopWords[word] {
			continue
		}
		out[word] = true
	}
	return out
}

func lessonSimilarity(a, b string) float64 {
	aTokens, bTokens := lessonTokens(a), lessonTokens(b)
	if len(aTokens) == 0 || len(bTokens) == 0 {
		if strings.EqualFold(strings.TrimSpace(a), strings.TrimSpace(b)) {
			return 1
		}
		return 0
	}
	intersection := 0
	union := map[string]bool{}
	for token := range aTokens {
		union[token] = true
		if bTokens[token] {
			intersection++
		}
	}
	for token := range bTokens {
		union[token] = true
	}
	return float64(intersection) / float64(len(union))
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}
