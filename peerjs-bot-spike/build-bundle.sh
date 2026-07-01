#!/usr/bin/env bash
# Assemble a self-contained AMS upload bundle for the bot DS.
#
# This AMS environment's `ams` CLI uploads a DIRECTORY with an executable (it has
# no Docker-push path) — the same model used for the Go bot-ds. Node isn't a
# single static binary, so we ship a bundle: the linux-x64 node binary + the app
# + its node_modules (incl. the @roamhq/wrtc prebuilt) + a run.sh launcher.
#
# We reuse the linux/amd64 Docker image (build-image.sh) purely as a reproducible
# BUILDER, then copy the exact node binary + deps out of it — so the bundle runs
# the same bits already validated in-container.
#
#   ./build-bundle.sh                 # -> build/ams/
#   OUT=/path ./build-bundle.sh       # custom output dir
#
# Then upload (mirrors the proven bot-ds command):
#   ams upload -c <clientId> -s <secret> \
#       -H seal.prod.gamingservices.accelbyte.io \
#       -n ethan-chess-bot -p build/ams -e run.sh -a linux-x86_64 \
#       --skip-script-validation
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${IMAGE:-ethan-chess-bot-ds:latest}"
OUT="${OUT:-$ROOT/build/ams}"

# 1. Build the linux/amd64 image (the builder).
IMAGE="$IMAGE" "$ROOT/build-image.sh"

# 2. Extract /app (app + node_modules + engine files) and the node binary.
rm -rf "$OUT"
mkdir -p "$OUT/app"
CID="$(docker create --platform linux/amd64 "$IMAGE")"
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT
docker cp "$CID:/app/." "$OUT/app/"
docker cp "$CID:/usr/local/bin/node" "$OUT/node"
chmod +x "$OUT/node"

# 3. Launcher: run from the app dir so relative imports + engine.mjs sibling
#    resolution behave exactly as in the container (WORKDIR /app).
cat > "$OUT/run.sh" <<'SH'
#!/bin/sh
# AMS runs this as the DS executable, substituting placeholders in the configured
# args ("-port=... -watchdog_url=..."). Print host diagnostics first (captured in
# AMS DS logs), then launch the DS forwarding those args.
HERE="$(cd "$(dirname "$0")" && pwd)"
echo "=== DS launch diagnostics ==="
uname -a 2>&1
(ldd --version 2>&1 | head -1) || echo "ldd: n/a"
chmod +x "$HERE/node" 2>/dev/null || true
echo "node --version: $("$HERE/node" --version 2>&1 || echo FAILED)"
WRTC="$HERE/app/node_modules/@roamhq/wrtc-linux-x64/wrtc.node"
echo "wrtc missing libs: $(ldd "$WRTC" 2>&1 | grep -i 'not found' | tr '\n' ' ' || echo none)"
echo "=== launching (args: $*) ==="
cd "$HERE/app"
exec "$HERE/node" ds.mjs "$@"
SH
chmod +x "$OUT/run.sh"

# DS config/secrets: AMS development build-configs have no env-var field, so we
# bundle a gitignored .env.ams as the app's .env (env.mjs reads it). Contains the
# bot creds + AGS config + BOT_TRIGGER_SECRET. The local dev .env is NOT shipped.
rm -f "$OUT/app/.env"
if [ -f "$ROOT/.env.ams" ]; then
  cp "$ROOT/.env.ams" "$OUT/app/.env"
  echo "Bundled .env.ams as app/.env"
else
  echo "WARNING: no .env.ams found — the DS will have no bot creds/config."
  echo "         Create peerjs-bot-spike/.env.ams (see .env.ams.example)."
fi

echo "Bundle ready at $OUT"
echo "Upload: ams upload -c <clientId> -s <secret> -H seal.prod.gamingservices.accelbyte.io -n ethan-chess-bot -p \"$OUT\" -e run.sh -a linux-x86_64 --skip-script-validation"
