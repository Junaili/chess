#!/usr/bin/env bash
# PRG-006 — provision the Progression System v2 backend configuration:
# stat definitions (blueprint §4.1) and achievement configs (§4.4) via the
# AGS CLI. Mirrors the legal:provision convention: DRY RUN by default
# (prints the plan, mutates nothing); pass --apply to execute.
#
#   scripts/provision-progression.sh                # plan only
#   scripts/provision-progression.sh --apply        # create what's missing
#   scripts/provision-progression.sh --apply --stats-only
#
# Idempotent: every code is get-checked first and skipped when it already
# exists, so re-running after a partial failure only creates the remainder.
#
# Auth: uses whatever `ags auth status` sees — either an `ags auth login`
# session or AGS_BASE_URL/AGS_CLIENT_ID/AGS_CLIENT_SECRET env vars (the
# client needs admin STATCONFIGURATION and ACHIEVEMENT permissions).
#
# Notes pinned by the blueprint:
# - All stats are setBy SERVER (§4.1: the client never writes stats). The
#   OVERRIDE/MAX/INCREMENT strategies in §4.1's table are per-WRITE
#   parameters in AGS Social, not definition-level config — they're listed
#   here as documentation of intent for the writer (cmd/dimension_batch.go).
# - Achievements ship hidden:false (§4.4), which means APPLYING THEM MAKES
#   THEM VISIBLE as locked achievements in the app's achievements panel
#   immediately. Use --stats-only to provision the invisible half early and
#   hold achievements until the progression UI ships.
# - Only first-review is 1:1 stat-mapped (BR-10.1) and therefore native
#   incremental (statCode prog-reviews-done, goal 1). Every other §4.4
#   achievement is context-gated, evaluated in ethan-chess-service, and
#   unlocked via the admin API — incremental:false, no statCode.
set -euo pipefail

NAMESPACE="${PROGRESSION_NAMESPACE:-seal-chessags}"
APPLY=0
STATS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --stats-only) STATS_ONLY=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

MODE="DRY RUN"
[ "$APPLY" = 1 ] && MODE="APPLY"
echo "### Progression provisioning — $MODE — namespace $NAMESPACE"
echo

created=0
skipped=0
planned=0
failed=0

# ---------------------------------------------------------------------------
# Stat definitions (§4.1). Fields: code|write-strategy|name
# ---------------------------------------------------------------------------
STATS=$(cat <<'EOF'
dim-accuracy|OVERRIDE|Dimension: accuracy (EWMA x100)
dim-pat|OVERRIDE|Dimension: tactics pattern (EWMA x100)
dim-calc|OVERRIDE|Dimension: tactics calculation (EWMA x100)
dim-endgame|OVERRIDE|Dimension: endgame (EWMA x100)
dim-blunder-res|OVERRIDE|Dimension: blunder resistance (EWMA x100)
dim-time-alloc|OVERRIDE|Dimension: time allocation (EWMA x100)
dim-accuracy-peak|MAX|Peak: accuracy
dim-pat-peak|MAX|Peak: tactics pattern
dim-calc-peak|MAX|Peak: tactics calculation
dim-endgame-peak|MAX|Peak: endgame
dim-blunder-res-peak|MAX|Peak: blunder resistance
dim-time-alloc-peak|MAX|Peak: time allocation
rec-clean-streak-best|MAX|Record: best clean-move streak
rec-comeback-best|MAX|Record: biggest comeback
rec-opp-defeated-best|MAX|Record: strongest opponent defeated
prog-games-analyzed|INCREMENT|Progression: games analyzed
prog-reviews-done|INCREMENT|Progression: reviews completed
prog-puzzles-atlevel|INCREMENT|Progression: at-level puzzles solved
imp-delta-90d|OVERRIDE|Improvement delta, trailing 90 days
streak-best|MAX|Best learning streak (archived)
EOF
)

stat_exists() {
  ags social stat-definitions get --namespace "$NAMESPACE" --stat-code "$1" >/dev/null 2>&1
}

provision_stat() {
  local code="$1" strategy="$2" name="$3"
  if stat_exists "$code"; then
    echo "  = stat $code (exists, skipped)"
    skipped=$((skipped + 1))
    return
  fi
  if [ "$APPLY" != 1 ]; then
    echo "  + stat $code  [write strategy: $strategy]"
    planned=$((planned + 1))
    return
  fi
  if ags social stat-definitions create --namespace "$NAMESPACE" --json "{
      \"statCode\": \"$code\",
      \"name\": \"$name\",
      \"description\": \"Progression v2 (blueprint §4.1). Written by ethan-chess-service with $strategy strategy.\",
      \"defaultValue\": 0,
      \"setBy\": \"SERVER\",
      \"tags\": [\"progression\"]
    }" >/dev/null; then
    echo "  ✓ stat $code created"
    created=$((created + 1))
  else
    echo "  ✗ stat $code FAILED" >&2
    failed=$((failed + 1))
  fi
}

echo "## Stat definitions (§4.1)"
while IFS='|' read -r code strategy name; do
  [ -n "$code" ] && provision_stat "$code" "$strategy" "$name"
done <<< "$STATS"
echo

# ---------------------------------------------------------------------------
# Achievements (§4.4). Fields: code|incremental|statCode|goal|name|description
# ---------------------------------------------------------------------------
ACHIEVEMENTS=$(cat <<'EOF'
first-clean-game|false||1|First Clean Game|Finish a game with zero blunders.
first-mate-in-3-live|false||1|Mate in Three|Deliver a checkmate you set up three moves ahead in a live game.
first-kp-endgame-win|false||1|King and Pawn Win|Convert your first king-and-pawn endgame.
first-save|false||1|The Save|Hold a lost position to a draw or better.
first-review|true|prog-reviews-done|1|First Review|Complete your first game review.
feat-clean-sheet-1|false||1|Clean Sheet I|Three clean games in a row against live opponents.
feat-clean-sheet-2|false||1|Clean Sheet II|Five clean games in a row against live opponents.
feat-clean-sheet-3|false||1|Clean Sheet III|Ten clean games in a row against live opponents.
feat-deep-water|false||1|Deep Water|Win a game that stayed sharp past move 40.
feat-houdini-rate|false||1|Escape Artist|Keep saving lost positions at a rate the record book notices.
feat-closer-1|false||1|Closer I|Convert three winning positions without letting the lead slip.
feat-closer-2|false||1|Closer II|Convert ten winning positions without letting the lead slip.
feat-closer-3|false||1|Closer III|Convert twenty-five winning positions without letting the lead slip.
EOF
)

achievement_exists() {
  ags achievement achievements get --namespace "$NAMESPACE" --achievement-code "$1" >/dev/null 2>&1
}

provision_achievement() {
  local code="$1" incremental="$2" stat_code="$3" goal="$4" name="$5" description="$6"
  if achievement_exists "$code"; then
    echo "  = achievement $code (exists, skipped)"
    skipped=$((skipped + 1))
    return
  fi
  if [ "$APPLY" != 1 ]; then
    local mapping="evaluator-unlocked"
    [ "$incremental" = "true" ] && mapping="incremental via $stat_code"
    echo "  + achievement $code  [$mapping]"
    planned=$((planned + 1))
    return
  fi
  local stat_field=""
  [ "$incremental" = "true" ] && stat_field="\"statCode\": \"$stat_code\","
  if ags achievement achievements create --namespace "$NAMESPACE" --json "{
      \"achievementCode\": \"$code\",
      \"defaultLanguage\": \"en\",
      \"name\": {\"en\": \"$name\"},
      \"description\": {\"en\": \"$description\"},
      \"goalValue\": $goal,
      \"hidden\": false,
      \"incremental\": $incremental,
      $stat_field
      \"lockedIcons\": [],
      \"unlockedIcons\": [],
      \"tags\": [\"progression\"]
    }" >/dev/null; then
    echo "  ✓ achievement $code created"
    created=$((created + 1))
  else
    echo "  ✗ achievement $code FAILED" >&2
    failed=$((failed + 1))
  fi
}

if [ "$STATS_ONLY" = 1 ]; then
  echo "## Achievements (§4.4) — skipped (--stats-only)"
else
  echo "## Achievements (§4.4)"
  if [ "$APPLY" = 1 ]; then
    echo "  (note: hidden:false — these appear as locked achievements in the app immediately)"
  fi
  while IFS='|' read -r code incremental stat_code goal name description; do
    [ -n "$code" ] && provision_achievement "$code" "$incremental" "$stat_code" "$goal" "$name" "$description"
  done <<< "$ACHIEVEMENTS"
fi

echo
echo "### Summary: created=$created planned=$planned skipped=$skipped failed=$failed"
[ "$APPLY" != 1 ] && echo "(dry run — re-run with --apply to create the planned items)"
[ "$failed" = 0 ]
