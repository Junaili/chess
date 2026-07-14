package main

// Club subscription + Ethan Coins (dev-plan/subscription-coins-implementation-plan.md
// Milestone 4). This file wires the HTTP handlers together; the actual AGS
// calls, ledger, family-role resolution, Stripe, and Open Journal Day logic
// live in the sibling monetization_*.go files.

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// clubSKU describes one purchasable Club tier/term. Coins is the amount
// deposited per grant (lifetime) or per paid period (monthly renewal).
// Mirrored in src/club-contract.mjs — keep both in sync when changing prices.
type clubSKU struct {
	Coins   int
	Monthly bool
	Family  bool
	AppleID string
}

var clubSKUs = map[string]clubSKU{
	"club-individual-monthly":  {Coins: 299, Monthly: true, Family: false, AppleID: "io.github.junaili.chess.club.individual.monthly"},
	"club-individual-lifetime": {Coins: 2999, Monthly: false, Family: false, AppleID: "io.github.junaili.chess.club.individual.lifetime"},
	"club-family-monthly":      {Coins: 399, Monthly: true, Family: true, AppleID: "io.github.junaili.chess.club.family.monthly"},
	"club-family-lifetime":     {Coins: 3999, Monthly: false, Family: true, AppleID: "io.github.junaili.chess.club.family.lifetime"},
}

const (
	ethanCoinCurrency = "ETHC"
	highFiveCost      = 10
	highFiveReward    = 5
	kudosStatCode     = "kudos-received"

	// Apple's monthly entitlement window gets a few days of grace so a
	// slightly-late renewal sync doesn't lapse a paying member's access.
	monthlyGraceDuration = 3 * 24 * time.Hour
)

func isClubSKU(sku string) bool {
	_, ok := clubSKUs[sku]
	return ok
}

func clubTier(sku string) string {
	if def, ok := clubSKUs[sku]; ok {
		if def.Family {
			return "family"
		}
		return "individual"
	}
	return ""
}

// clubSKUsByTier returns the two SKUs (monthly, lifetime) for "individual" or
// "family", in that order. Used by the family-inheritance check (§6.3) which
// only ever cares about the two club-family-* SKUs.
func clubSKUsForFamily() []string {
	return []string{"club-family-monthly", "club-family-lifetime"}
}

type monetizationHandler struct {
	agsBaseURL   string
	namespace    string
	clientID     string
	clientSecret string
	webBaseURL   string
	botUserID    string

	stripeSecretKey     string
	stripeWebhookSecret string

	httpClient *http.Client
	now        func() time.Time

	items   *itemCatalogCache
	roles   *familyRolesCache
	journal *openJournalConfigCache
}

func newMonetizationHandlerFromEnv() *monetizationHandler {
	h := &monetizationHandler{
		agsBaseURL:          strings.TrimRight(os.Getenv("AB_BASE_URL"), "/"),
		namespace:           os.Getenv("AB_NAMESPACE"),
		clientID:            os.Getenv("AB_CLIENT_ID"),
		clientSecret:        os.Getenv("AB_CLIENT_SECRET"),
		webBaseURL:          strings.TrimRight(defaultString(os.Getenv("WEB_BASE_URL"), "https://junaili.github.io/chess"), "/"),
		botUserID:           os.Getenv("BOT_USER_ID"),
		stripeSecretKey:     os.Getenv("STRIPE_SECRET_KEY"),
		stripeWebhookSecret: os.Getenv("STRIPE_WEBHOOK_SECRET"),
		httpClient:          &http.Client{Timeout: 15 * time.Second},
		now:                 time.Now,
	}
	h.items = newItemCatalogCache(h)
	h.roles = newFamilyRolesCache(h)
	h.journal = newOpenJournalConfigCache(h)
	return h
}

func writeMonetizationError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code, "message": message})
}

func writeMonetizationJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

// ---------------------------------------------------------------------------
// GET /club/status
// ---------------------------------------------------------------------------

type clubStatusResponse struct {
	Active                   bool             `json:"active"`
	Tier                     string           `json:"tier,omitempty"`
	Source                   string           `json:"source,omitempty"`
	Lifetime                 bool             `json:"lifetime"`
	ExpiresAt                string           `json:"expiresAt,omitempty"`
	ActiveSkus               []string         `json:"activeSkus"`
	MonthlyOrigin            string           `json:"monthlyOrigin,omitempty"`
	Coins                    int64            `json:"coins"`
	CanPurchase              bool             `json:"canPurchase"`
	JournalOpen              *journalOpenInfo `json:"journalOpen"`
	NarrativesRemainingToday *int             `json:"narrativesRemainingToday"`
}

func (h *monetizationHandler) status(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMonetizationError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
		return
	}
	userID := subFromContext(r.Context())
	if userID == "" {
		writeMonetizationError(w, http.StatusUnauthorized, "unauthenticated", "Sign in again.")
		return
	}

	resp, err := h.computeStatus(userID, accessTokenFromContext(r.Context()))
	if err != nil {
		log.Printf("[monetization] status(%s): %v", userID, err)
		writeMonetizationError(w, http.StatusBadGateway, "status_unavailable", "Could not load Club status. Try again.")
		return
	}
	writeMonetizationJSON(w, http.StatusOK, resp)
}

// computeStatus implements §6.3 (effective-status computation) + §6.5 (coin
// reconciliation, run as a side effect) + §8.5 (Open Journal Day info).
// callerToken is the caller's OWN forwarded bearer token, required for the
// family-role lookup (see monetization_family.go's package comment — this
// AGS deployment rejects S2S tokens for every Group endpoint).
func (h *monetizationHandler) computeStatus(userID, callerToken string) (clubStatusResponse, error) {
	entitlements, err := h.activeClubEntitlements(userID)
	if err != nil {
		return clubStatusResponse{}, fmt.Errorf("query entitlements: %w", err)
	}

	// Reconciliation must run BEFORE we decide the response — a renewal that
	// just landed should show up in the same call that reports it as active.
	if err := h.reconcileCoins(userID, entitlements); err != nil {
		// Reconciliation failures degrade to "status without fresh coins",
		// never to an error response — a stuck LLM/network hiccup here must
		// not make Club membership look broken.
		log.Printf("[monetization] reconcile(%s): %v", userID, err)
	}

	resp := clubStatusResponse{ActiveSkus: []string{}}
	best := bestActiveEntitlement(entitlements, h.now())
	if best != nil {
		resp.Active = true
		resp.Tier = clubTier(best.SKU)
		resp.Source = "self"
		resp.Lifetime = !clubSKUs[best.SKU].Monthly
		if !resp.Lifetime {
			resp.ExpiresAt = best.EndDate
		}
	}
	for _, e := range entitlements {
		resp.ActiveSkus = append(resp.ActiveSkus, e.SKU)
	}
	resp.MonthlyOrigin = monthlyOrigin(entitlements)

	role, guardianID, familyErr := h.roles.resolveSelf(userID, callerToken)
	if familyErr != nil {
		log.Printf("[monetization] family role lookup(%s): %v", userID, familyErr)
		resp.CanPurchase = true // fail open on the read check; server-side purchase endpoints re-check independently
	} else {
		resp.CanPurchase = role != "child"
		if !resp.Active && role == "child" && guardianID != "" {
			guardianEntitlements, err := h.activeClubStatus(guardianID, clubSKUsForFamily())
			if err != nil {
				log.Printf("[monetization] guardian entitlements(%s): %v", guardianID, err)
			} else if best := bestActiveEntitlement(guardianEntitlements, h.now()); best != nil {
				resp.Active = true
				resp.Tier = "family"
				resp.Source = "family-guardian"
				resp.Lifetime = !clubSKUs[best.SKU].Monthly
				if !resp.Lifetime {
					resp.ExpiresAt = best.EndDate
				}
			}
		}
	}

	balance, err := h.getWalletBalance(userID)
	if err != nil {
		log.Printf("[monetization] wallet balance(%s): %v", userID, err)
	}
	resp.Coins = balance

	openInfo := h.journal.statusNow()
	resp.JournalOpen = openInfo
	if !resp.Active {
		remaining, err := h.narrativesRemainingToday(userID, openInfo)
		if err != nil {
			log.Printf("[monetization] narrative quota(%s): %v", userID, err)
		} else {
			resp.NarrativesRemainingToday = &remaining
		}
	}

	return resp, nil
}

func monthlyOrigin(entitlements []clubEntitlement) string {
	for _, e := range entitlements {
		if clubSKUs[e.SKU].Monthly {
			return e.Origin
		}
	}
	return ""
}

// bestActiveEntitlement prefers lifetime over monthly, and family over
// individual, per §7.6's status-computation rule.
func bestActiveEntitlement(entitlements []clubEntitlement, now time.Time) *clubEntitlement {
	var best *clubEntitlement
	rank := func(e clubEntitlement) int {
		def := clubSKUs[e.SKU]
		score := 0
		if !def.Monthly {
			score += 2 // lifetime beats monthly
		}
		if def.Family {
			score += 1 // family beats individual
		}
		return score
	}
	for i := range entitlements {
		e := entitlements[i]
		if !e.isActive(now) {
			continue
		}
		if best == nil || rank(e) > rank(*best) {
			best = &entitlements[i]
		}
	}
	return best
}

// ---------------------------------------------------------------------------
// POST /club/web-checkout
// ---------------------------------------------------------------------------

func (h *monetizationHandler) webCheckout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMonetizationError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
		return
	}
	userID := subFromContext(r.Context())
	if userID == "" {
		writeMonetizationError(w, http.StatusUnauthorized, "unauthenticated", "Sign in again.")
		return
	}
	if h.stripeSecretKey == "" {
		writeMonetizationError(w, http.StatusServiceUnavailable, "billing_unavailable", "Web purchases are temporarily unavailable.")
		return
	}

	var body struct {
		SKU string `json:"sku"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body); err != nil || !isClubSKU(body.SKU) {
		writeMonetizationError(w, http.StatusBadRequest, "invalid_sku", "Unknown Club plan.")
		return
	}

	role, _, err := h.roles.resolveSelf(userID, accessTokenFromContext(r.Context()))
	if err != nil {
		writeMonetizationError(w, http.StatusBadGateway, "role_unavailable", "Could not verify your account. Try again.")
		return
	}
	if role == "child" {
		writeMonetizationError(w, http.StatusForbidden, "child_purchase_blocked", "Ask your parent to buy Club.")
		return
	}

	url, customerID, err := h.createStripeCheckoutSession(userID, body.SKU)
	if err != nil {
		log.Printf("[monetization] web-checkout(%s, %s): %v", userID, body.SKU, err)
		writeMonetizationError(w, http.StatusBadGateway, "checkout_failed", "Could not start checkout. Try again.")
		return
	}
	if customerID != "" {
		if _, _, err := h.mutateLedger(userID, func(l *monetizationLedger) bool {
			if l.StripeCustomerID == customerID {
				return false
			}
			l.StripeCustomerID = customerID
			return true
		}); err != nil {
			log.Printf("[monetization] persist stripeCustomerId(%s): %v", userID, err)
		}
	}
	writeMonetizationJSON(w, http.StatusOK, map[string]string{"url": url})
}

// ---------------------------------------------------------------------------
// POST /club/web-portal
// ---------------------------------------------------------------------------

func (h *monetizationHandler) webPortal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMonetizationError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
		return
	}
	userID := subFromContext(r.Context())
	if userID == "" {
		writeMonetizationError(w, http.StatusUnauthorized, "unauthenticated", "Sign in again.")
		return
	}
	ledger, _, err := h.readLedger(userID)
	if err != nil || ledger.StripeCustomerID == "" {
		writeMonetizationError(w, http.StatusNotFound, "no_stripe_customer", "No web subscription found on this account.")
		return
	}
	url, err := h.createStripePortalSession(ledger.StripeCustomerID)
	if err != nil {
		log.Printf("[monetization] web-portal(%s): %v", userID, err)
		writeMonetizationError(w, http.StatusBadGateway, "portal_failed", "Could not open the billing portal. Try again.")
		return
	}
	writeMonetizationJSON(w, http.StatusOK, map[string]string{"url": url})
}

// ---------------------------------------------------------------------------
// POST /coins/highfive  (§6.7)
// ---------------------------------------------------------------------------

func (h *monetizationHandler) highFive(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMonetizationError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
		return
	}
	senderID := subFromContext(r.Context())
	if senderID == "" {
		writeMonetizationError(w, http.StatusUnauthorized, "unauthenticated", "Sign in again.")
		return
	}

	var body struct {
		MatchID         string `json:"matchId"`
		RecipientUserID string `json:"recipientUserId"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body); err != nil {
		writeMonetizationError(w, http.StatusBadRequest, "invalid_request", "Invalid High Five request.")
		return
	}
	matchID := strings.TrimSpace(body.MatchID)
	recipientID := strings.TrimSpace(body.RecipientUserID)
	if !validHighFiveTarget(senderID, recipientID, matchID, h.botUserID) {
		writeMonetizationError(w, http.StatusBadRequest, "invalid_target", "Can't send a High Five here.")
		return
	}

	txKey := txKeyHighFive(matchID, senderID)
	ledger, _, err := h.readLedger(senderID)
	if err != nil {
		writeMonetizationError(w, http.StatusBadGateway, "highfive_unavailable", "Could not send High Five. Try again.")
		return
	}
	if _, exists := ledger.Debits[txKey]; exists {
		// Cheap pre-check for the common case (fast 409 without a write
		// round-trip); mutateLedger below is the real, race-safe guard.
		writeMonetizationError(w, http.StatusConflict, "already_sent", "You already sent a High Five for this match.")
		return
	}

	// Record the debit BEFORE moving real currency (§6.4 ordering): a crash
	// between here and the wallet call leaves an orphaned ledger row that
	// blocks a retry, which is safer than a retry double-spending.
	_, wrote, err := h.mutateLedger(senderID, func(l *monetizationLedger) bool {
		if _, exists := l.Debits[txKey]; exists {
			return false
		}
		l.Debits[txKey] = ledgerEntry{Amount: highFiveCost, At: h.now().UTC().Format(time.RFC3339), Kind: "highfive"}
		return true
	})
	if err != nil {
		writeMonetizationError(w, http.StatusBadGateway, "highfive_unavailable", "Could not send High Five. Try again.")
		return
	}
	if !wrote {
		// A concurrent request (the classic double-tap) beat us to this exact
		// txKey between the pre-check above and this write — do NOT debit.
		writeMonetizationError(w, http.StatusConflict, "already_sent", "You already sent a High Five for this match.")
		return
	}

	if err := h.debitUserWallet(senderID, highFiveCost, "OTHER", "highfive:"+matchID, false); err != nil {
		// Roll back the ledger row so a retry (or the balance-check UI) isn't
		// permanently blocked by a debit that never actually happened.
		_, _, _ = h.mutateLedger(senderID, func(l *monetizationLedger) bool {
			if _, exists := l.Debits[txKey]; !exists {
				return false
			}
			delete(l.Debits, txKey)
			return true
		})
		if isInsufficientBalanceErr(err) {
			balance, _ := h.getWalletBalance(senderID)
			writeMonetizationJSON(w, http.StatusPaymentRequired, map[string]any{
				"error": "insufficient_coins", "message": "Not enough coins.", "senderBalance": balance,
			})
			return
		}
		log.Printf("[monetization] highfive debit(%s): %v", senderID, err)
		writeMonetizationError(w, http.StatusBadGateway, "highfive_unavailable", "Could not send High Five. Try again.")
		return
	}

	if err := h.creditUserWallet(recipientID, highFiveReward, "GIFT", "highfive-reward:"+matchID); err != nil {
		log.Printf("[monetization] highfive reward credit failed, sender already debited (sender=%s recipient=%s match=%s): %v", senderID, recipientID, matchID, err)
		// Sender already paid; do not roll back (the plan accepts this as a
		// "log loudly" best-effort case — the alternative, refunding the
		// sender, would let a flaky recipient wallet be gamed for free
		// retries). Continue: still record recipient-side kind for audit.
	} else {
		_, _, _ = h.mutateLedger(recipientID, func(l *monetizationLedger) bool {
			creditKey := "hf-recv:" + matchID + ":" + senderID
			if _, exists := l.Credits[creditKey]; exists {
				return false
			}
			l.Credits[creditKey] = ledgerEntry{Amount: highFiveReward, At: h.now().UTC().Format(time.RFC3339), Kind: "highfive-reward"}
			return true
		})
		if err := h.incrementKudos(recipientID); err != nil {
			log.Printf("[monetization] kudos increment(%s): %v", recipientID, err)
		}
	}

	balance, _ := h.getWalletBalance(senderID)
	writeMonetizationJSON(w, http.StatusOK, map[string]any{"ok": true, "senderBalance": balance})
}

func validHighFiveTarget(senderID, recipientID, matchID, botUserID string) bool {
	if senderID == "" || recipientID == "" || matchID == "" {
		return false
	}
	if senderID == recipientID {
		return false
	}
	if botUserID != "" && recipientID == botUserID {
		return false
	}
	if len(matchID) > 128 || len(recipientID) > 128 {
		return false
	}
	return true
}

// ---------------------------------------------------------------------------
// POST /coins/give  (§6.8 — guardian → child allowance)
// ---------------------------------------------------------------------------

func (h *monetizationHandler) give(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMonetizationError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
		return
	}
	guardianID := subFromContext(r.Context())
	if guardianID == "" {
		writeMonetizationError(w, http.StatusUnauthorized, "unauthenticated", "Sign in again.")
		return
	}
	var body struct {
		RecipientUserID string `json:"recipientUserId"`
		Amount          int64  `json:"amount"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body); err != nil {
		writeMonetizationError(w, http.StatusBadRequest, "invalid_request", "Invalid request.")
		return
	}
	recipientID := strings.TrimSpace(body.RecipientUserID)
	if recipientID == "" || recipientID == guardianID || body.Amount < 1 {
		writeMonetizationError(w, http.StatusBadRequest, "invalid_request", "Invalid allowance request.")
		return
	}

	isGuardianOfChild, err := h.roles.isGuardianOfWithinOwnGroup(guardianID, accessTokenFromContext(r.Context()), recipientID)
	if err != nil {
		writeMonetizationError(w, http.StatusBadGateway, "family_unavailable", "Could not verify your family. Try again.")
		return
	}
	if !isGuardianOfChild {
		writeMonetizationError(w, http.StatusForbidden, "not_guardian", "You can only give coins to your own children.")
		return
	}

	// KNOWN GAP: unlike every other money-moving endpoint in this file,
	// /coins/give has no client-idempotency-key protection — a network retry
	// of this exact POST (not a webhook, so no natural replay id) could debit
	// the guardian twice. Flagged for a follow-up milestone: require the
	// client to send a UUID and dedupe on it the same way High Five dedupes
	// on matchId+senderId. Not fixed here to keep this change reviewable.
	txID := fmt.Sprintf("%s-%d", guardianID, h.now().UnixNano())
	if err := h.debitUserWallet(guardianID, body.Amount, "OTHER", "allowance-to:"+recipientID, false); err != nil {
		if isInsufficientBalanceErr(err) {
			balance, _ := h.getWalletBalance(guardianID)
			writeMonetizationJSON(w, http.StatusPaymentRequired, map[string]any{
				"error": "insufficient_coins", "message": "Not enough coins.", "balance": balance,
			})
			return
		}
		log.Printf("[monetization] allowance debit(%s): %v", guardianID, err)
		writeMonetizationError(w, http.StatusBadGateway, "allowance_failed", "Could not give coins. Try again.")
		return
	}
	if err := h.creditUserWallet(recipientID, body.Amount, "GIFT", "allowance-from:"+guardianID); err != nil {
		log.Printf("[monetization] allowance credit failed, guardian already debited (guardian=%s child=%s amount=%d): %v", guardianID, recipientID, body.Amount, err)
		writeMonetizationError(w, http.StatusBadGateway, "allowance_failed", "Could not give coins. Try again.")
		return
	}
	_, _, _ = h.mutateLedger(guardianID, func(l *monetizationLedger) bool {
		l.Debits[txKeyAllowance(txID)] = ledgerEntry{Amount: int(body.Amount), At: h.now().UTC().Format(time.RFC3339), Kind: "allowance"}
		return true
	})
	_, _, _ = h.mutateLedger(recipientID, func(l *monetizationLedger) bool {
		l.Credits[txKeyAllowance(txID)] = ledgerEntry{Amount: int(body.Amount), At: h.now().UTC().Format(time.RFC3339), Kind: "allowance"}
		return true
	})

	balance, _ := h.getWalletBalance(guardianID)
	writeMonetizationJSON(w, http.StatusOK, map[string]any{"ok": true, "guardianBalance": balance})
}
