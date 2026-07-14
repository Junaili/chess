#!/usr/bin/env bash
# Build the AMS bot DS container image (ds.mjs) for linux/amd64.
#
# The bot depends on the game's chess-engine.js / ai-engine.js which live in the
# repo root (parent dir). To keep the build context small and self-contained
# (and avoid a repo-root .dockerignore), we stage a flat dir with just what the
# image needs — the bot .mjs files plus the two engine files copied in beside
# engine.mjs — and build from there.
#
#   ./build-image.sh                    # builds ethan-chess-bot-ds:latest
#   IMAGE=my/repo:tag ./build-image.sh  # custom tag (e.g. the AMS ECR repo)
#
# Then push/register with AMS (container-image fleet). AMS runs linux/amd64, so
# we always target that platform (emulated on Apple Silicon; wrtc is a prebuilt
# download, so no cross-compile is needed).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
IMAGE="${IMAGE:-ethan-chess-bot-ds:latest}"
PLATFORM="${PLATFORM:-linux/amd64}"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Bot runtime files + manifests + Dockerfile.
cp "$ROOT"/ds.mjs "$ROOT"/watchdog.mjs "$ROOT"/play.mjs "$ROOT"/ai-pool.mjs \
   "$ROOT"/ai-worker.mjs "$ROOT"/ags.mjs \
   "$ROOT"/engine.mjs "$ROOT"/env.mjs "$ROOT"/package.json \
   "$ROOT"/package-lock.json "$ROOT"/Dockerfile "$ROOT"/.dockerignore "$STAGE"/
# Game engine files (repo root) staged beside engine.mjs so its sibling-first
# resolution finds them inside the image.
cp "$REPO"/chess-engine.js "$REPO"/ai-engine.js "$STAGE"/

echo "Building $IMAGE ($PLATFORM) from staged context $STAGE"
docker build --platform "$PLATFORM" -t "$IMAGE" "$STAGE"
echo "Built $IMAGE"
