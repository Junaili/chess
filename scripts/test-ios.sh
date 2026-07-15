#!/usr/bin/env bash
#
# iOS / iPad simulator smoke test for Ethan's Chess.
#
# The Capacitor app loads the SAME web bundle that the Playwright WebKit/iPad
# project drives end-to-end, so this script's job is narrower: prove the native
# iOS shell builds, installs, launches, and renders the app in a WKWebView on an
# iPad simulator. It is intentionally NOT part of the fast pre-commit gate
# (xcodebuild is slow); run it on demand or in CI with `npm run test:ios`.
#
# Override the target simulator with IOS_SIM_UDID; otherwise a booted iPad is
# reused, or the first available iPad is booted.
set -euo pipefail

# CocoaPods / ruby / xcodebuild helpers live in Homebrew on Apple Silicon.
export PATH="/opt/homebrew/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUNDLE_ID="$(node -p "require('./capacitor.config.json').appId")"
PROJECT="ios/App/App.xcodeproj"
SCHEME="App"
DERIVED="$ROOT/ios/DerivedData"
SHOT_DIR="$ROOT/test-results/ios"
SHOT="$SHOT_DIR/home.png"
mkdir -p "$SHOT_DIR"

log() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# ── Pick a simulator ─────────────────────────────────────────────────────────
pick_ipad() {
  if [[ -n "${IOS_SIM_UDID:-}" ]]; then echo "$IOS_SIM_UDID"; return; fi
  # Reuse a booted iPad if one exists.
  local booted
  booted="$(xcrun simctl list devices booted | grep -i ipad | grep -oE '[0-9A-F-]{36}' | head -1 || true)"
  if [[ -n "$booted" ]]; then echo "$booted"; return; fi
  # Otherwise the first available iPad.
  xcrun simctl list devices available | grep -i ipad | grep -oE '[0-9A-F-]{36}' | head -1
}

UDID="$(pick_ipad)"
[[ -n "$UDID" ]] || fail "No iPad simulator found. Create one in Xcode > Settings > Platforms."
log "Using simulator $UDID"

if ! xcrun simctl list devices booted | grep -q "$UDID"; then
  log "Booting simulator…"
  xcrun simctl boot "$UDID"
fi
xcrun simctl bootstatus "$UDID" -b

# ── Build the web bundle and sync it into the iOS project ────────────────────
log "Building web bundle (capacitor target) + cap sync ios…"
npm run ios:build

# ── Build the iOS app for the simulator ──────────────────────────────────────
log "xcodebuild (iphonesimulator, Debug)…"
xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination "id=$UDID" \
  -derivedDataPath "$DERIVED" \
  build | tail -5

APP_PATH="$(find "$DERIVED/Build/Products" -maxdepth 2 -name '*.app' -type d | head -1)"
[[ -n "$APP_PATH" ]] || fail "Build succeeded but no .app bundle was found under $DERIVED."
log "Built $APP_PATH"

# ── Install, launch, screenshot ──────────────────────────────────────────────
log "Installing and launching ${BUNDLE_ID}…"
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl install "$UDID" "$APP_PATH"
PID="$(xcrun simctl launch "$UDID" "$BUNDLE_ID" | grep -oE '[0-9]+$' || true)"
[[ -n "$PID" ]] || fail "App failed to launch."
log "Launched with PID $PID"

# Give the WKWebView time to load dist/ and render the home screen.
sleep 8

# A rendered screenshot is the runtime assertion. Newer simulator runtimes no
# longer expose UIKitApplication labels consistently through `launchctl list`,
# which caused a false crash report even while the app was visibly running.
xcrun simctl io "$UDID" screenshot "$SHOT"
# A blank/failed render produces a tiny file; a real screen is tens of KB+.
SIZE="$(stat -f%z "$SHOT" 2>/dev/null || stat -c%s "$SHOT")"
[[ "$SIZE" -gt 10000 ]] || fail "Screenshot looks empty ($SIZE bytes) — the web bundle may not have rendered."

log "iOS smoke PASSED — app booted and rendered on iPad sim. Screenshot: $SHOT ($SIZE bytes)"
