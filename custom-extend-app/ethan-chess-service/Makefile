SHELL := /bin/bash

PROJECT_NAME := $(shell basename "$$(pwd)")
PROTOC_IMAGE := proto-builder
IS_INSIDE_DEVCONTAINER := $(REMOTE_CONTAINERS)

proto_image:
ifneq ($(IS_INSIDE_DEVCONTAINER),true)
	docker build --target proto-builder -t $(PROTOC_IMAGE) .
endif

proto: proto_image
ifneq ($(IS_INSIDE_DEVCONTAINER),true)
	docker run --tty --rm --user $$(id -u):$$(id -g) \
		--volume $$(pwd):/build \
		--workdir /build \
		--entrypoint /bin/bash \
		$(PROTOC_IMAGE) \
		proto.sh
else
	./proto.sh
endif

# ── AMS bot dedicated server ──────────────────────────────────────────────────
BOT ?= gambit-gus

# Cross-compile bot-ds for the AMS host (linux/amd64, static) and stage an upload
# folder containing the binary + the bot's brain/style/persona. Then upload with
# the AMS CLI (replace host/client values):
#   ams upload -H <host> -c <id> -s <secret> -n bot-ds -p build/ams \
#       -e "./bot-ds --bot-dir bots/$(BOT)"
bot-ds-build:
	rm -rf build/ams
	mkdir -p build/ams/bots
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o build/ams/bot-ds ./cmd/bot-ds
	cp -R bots/$(BOT) build/ams/bots/$(BOT)
	@echo "Staged build/ams: bot-ds (linux/amd64) + bots/$(BOT)"
	@echo "Upload: ams upload -H <host> -c <id> -s <secret> -n bot-ds -p build/ams -e \"./bot-ds --bot-dir bots/$(BOT)\""

# Run bot-ds locally against the AMS Simulator's watchdog (download the Simulator
# from Admin Portal -> AMS -> CLI tools and start it first).
bot-ds-run-sim:
	go run ./cmd/bot-ds --bot-dir bots/$(BOT) --watchdog-url ws://localhost:5555/watchdog
