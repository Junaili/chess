package main

// Open Journal Days (§8.5): a namespace-level, Admin-Portal-editable config
// that opens the full journal (history + entry writing + Coach Gus notes) to
// every signed-in user on configured occasions, with no redeploy required to
// add or remove a date.

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

const (
	openJournalConfigKey = "club-open-journal-config"
	openJournalConfigTTL = 5 * time.Minute
	defaultNarrativeCap  = 3
	freeWeeklyNarratives = 1
)

type openJournalDateRange struct {
	Start string `json:"start"` // "2026-12-24" (date only, inclusive)
	End   string `json:"end"`   // inclusive
	Label string `json:"label"`
}

type openJournalConfig struct {
	WeeklyDay         *int                   `json:"weeklyDay"` // 0=Sunday UTC; nil/omitted disables
	Dates             []openJournalDateRange `json:"dates"`
	NarrativeDailyCap int                    `json:"narrativeDailyCap"`
}

type journalOpenInfo struct {
	Active bool   `json:"active"`
	Label  string `json:"label,omitempty"`
	EndsAt string `json:"endsAt,omitempty"`
}

type openJournalConfigCache struct {
	h  *monetizationHandler
	mu sync.RWMutex

	config   openJournalConfig
	loadedAt time.Time
}

func newOpenJournalConfigCache(h *monetizationHandler) *openJournalConfigCache {
	return &openJournalConfigCache{h: h}
}

func (c *openJournalConfigCache) get() openJournalConfig {
	c.mu.RLock()
	fresh := time.Since(c.loadedAt) < openJournalConfigTTL
	cfg := c.config
	c.mu.RUnlock()
	if fresh {
		return cfg
	}

	raw, err := c.h.getAdminGameRecord(openJournalConfigKey)
	// A missing or malformed config record fails CLOSED (§8.5 acceptance
	// criteria: "malformed record (fail closed = not active)") — a config
	// bug must never accidentally give away unlimited free LLM calls.
	cfg = openJournalConfig{}
	if err == nil && raw != nil {
		_ = json.Unmarshal(raw, &cfg) // best-effort; zero-value cfg on failure
	}
	if cfg.NarrativeDailyCap <= 0 {
		cfg.NarrativeDailyCap = defaultNarrativeCap
	}

	c.mu.Lock()
	c.config = cfg
	c.loadedAt = time.Now()
	c.mu.Unlock()
	return cfg
}

// journalOpenNow computes whether an Open Journal occasion is active right
// now, in UTC. Pure given a config + now — the network fetch lives in get().
func journalOpenNow(cfg openJournalConfig, now time.Time) journalOpenInfo {
	now = now.UTC()
	today := now.Format("2006-01-02")

	for _, d := range cfg.Dates {
		if d.Start == "" || d.End == "" {
			continue
		}
		if today >= d.Start && today <= d.End {
			endOfDay, err := time.Parse("2006-01-02", d.End)
			if err != nil {
				continue
			}
			endsAt := endOfDay.Add(24 * time.Hour) // inclusive end date -> exclusive boundary at next midnight UTC
			return journalOpenInfo{Active: true, Label: nonEmptyLabel(d.Label, "Open Journal Days"), EndsAt: endsAt.Format(time.RFC3339)}
		}
	}

	if cfg.WeeklyDay != nil && int(now.Weekday()) == *cfg.WeeklyDay {
		startOfDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
		endsAt := startOfDay.Add(24 * time.Hour)
		return journalOpenInfo{Active: true, Label: "Open Journal Sunday", EndsAt: endsAt.Format(time.RFC3339)}
	}

	return journalOpenInfo{Active: false}
}

func nonEmptyLabel(label, fallback string) string {
	if label == "" {
		return fallback
	}
	return label
}

func (c *openJournalConfigCache) statusNow() *journalOpenInfo {
	info := journalOpenNow(c.get(), c.h.now())
	if !info.Active {
		return nil
	}
	return &info
}

// narrativesRemainingToday computes the non-Club caller's remaining Coach Gus
// notes for today: unlimited-looking large number is never returned here —
// Club members don't call this path at all (see computeStatus).
func (h *monetizationHandler) narrativesRemainingToday(userID string, openInfo *journalOpenInfo) (int, error) {
	cfg := h.journal.get()
	ledger, _, err := h.readLedger(userID)
	if err != nil {
		return 0, err
	}
	now := h.now().UTC()
	if openInfo != nil && openInfo.Active {
		used := ledger.Counters[txKeyNarrativeDay(now.Format("2006-01-02"))]
		remaining := cfg.NarrativeDailyCap - used
		if remaining < 0 {
			remaining = 0
		}
		return remaining, nil
	}
	week := isoWeekKey(now)
	used := ledger.Counters[txKeyNarrativeWeek(week)]
	if used >= freeWeeklyNarratives {
		return 0, nil
	}
	return freeWeeklyNarratives - used, nil
}

func isoWeekKey(t time.Time) string {
	year, week := t.ISOWeek()
	return fmt.Sprintf("%d-W%02d", year, week)
}

// coachReportGate implements the /coach/report enforcement decision from
// §8.5: Club (self or family-guardian) is unlimited; otherwise Open Journal
// Day quota, then the free weekly allowance, then refused.
//
// This is the ONE place real LLM spend is gated — everything else about the
// journal (history depth, entry writing) is client-enforced only, by design
// (§1.2: zero-COGS data the user already owns).
type coachGateDecision struct {
	Allowed bool
	Reason  string // "club" | "open-day" | "weekly-free" | "exhausted"
}

func (h *monetizationHandler) coachReportGate(userID, callerToken string) (coachGateDecision, error) {
	status, err := h.computeClubActiveOnly(userID, callerToken)
	if err != nil {
		return coachGateDecision{}, err
	}
	if status {
		return coachGateDecision{Allowed: true, Reason: "club"}, nil
	}

	openInfo := h.journal.statusNow()
	now := h.now().UTC()
	if openInfo != nil && openInfo.Active {
		cfg := h.journal.get()
		dayKey := txKeyNarrativeDay(now.Format("2006-01-02"))
		// `wrote` (not a derived comparison on the returned counter value) is
		// the correct signal here: fn only increments — and therefore only
		// returns true — when strictly under quota. A comparison like
		// "counter <= cap" is wrong at the boundary: when the quota is
		// already exhausted, fn declines (wrote=false) but the counter it
		// reads back is STILL <= cap (it's exactly at cap), which would
		// incorrectly read as "allowed" if wrote weren't checked directly.
		_, wrote, err := h.mutateLedger(userID, func(l *monetizationLedger) bool {
			if l.Counters[dayKey] >= cfg.NarrativeDailyCap {
				return false
			}
			l.Counters[dayKey]++
			return true
		})
		if err != nil {
			return coachGateDecision{}, err
		}
		if wrote {
			return coachGateDecision{Allowed: true, Reason: "open-day"}, nil
		}
		return coachGateDecision{Allowed: false, Reason: "exhausted"}, nil
	}

	weekKey := txKeyNarrativeWeek(isoWeekKey(now))
	_, wrote, err := h.mutateLedger(userID, func(l *monetizationLedger) bool {
		if l.Counters[weekKey] >= freeWeeklyNarratives {
			return false
		}
		l.Counters[weekKey]++
		return true
	})
	if err != nil {
		return coachGateDecision{}, err
	}
	if wrote {
		return coachGateDecision{Allowed: true, Reason: "weekly-free"}, nil
	}
	return coachGateDecision{Allowed: false, Reason: "exhausted"}, nil
}

// computeClubActiveOnly is a lighter version of computeStatus for the
// coach-report gate: skips reconciliation and coin balance (not needed here)
// to keep the hot LLM-gating path fast.
func (h *monetizationHandler) computeClubActiveOnly(userID, callerToken string) (bool, error) {
	entitlements, err := h.activeClubEntitlements(userID)
	if err != nil {
		return false, err
	}
	if bestActiveEntitlement(entitlements, h.now()) != nil {
		return true, nil
	}
	role, guardianID, err := h.roles.resolveSelf(userID, callerToken)
	if err != nil {
		return false, err
	}
	if role != "child" || guardianID == "" {
		return false, nil
	}
	guardianEntitlements, err := h.activeClubStatus(guardianID, clubSKUsForFamily())
	if err != nil {
		return false, err
	}
	return bestActiveEntitlement(guardianEntitlements, h.now()) != nil, nil
}
