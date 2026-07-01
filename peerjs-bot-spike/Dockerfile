# AMS dedicated-server image for the chess bot (ds.mjs).
#
# Built from a flat staging dir (see build-image.sh) that already contains the
# bot's .mjs files, package manifests, and the game's chess-engine.js/ai-engine.js
# copied in beside engine.mjs. Node (not a static binary) is why the DS is a
# container image rather than the executable-upload used for the Go bot-ds.
#
# @roamhq/wrtc ships a prebuilt native addon for linux/x64 (glibc) — hence the
# bookworm-slim (glibc) base, NOT alpine (musl).
FROM node:20-bookworm-slim

WORKDIR /app

# Install deps first for layer caching. --omit=dev: runtime deps only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App sources (flat staging context includes the engine files beside engine.mjs).
COPY . .

ENV NODE_ENV=production
# The DS binds this fixed container port; AMS maps it to a public host port and
# reports the mapping to the claimer. Declare/publish it in the fleet config.
ENV BOT_TRIGGER_PORT=8091
EXPOSE 8091

CMD ["node", "ds.mjs"]
