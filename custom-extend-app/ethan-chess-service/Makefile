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
# One artifact hosts every personality. A claimed DS picks which one to answer as
# from the game session's match pool, so a single fleet serves all of them and
# BOT only chooses the local-dev default.
BOT ?= gambit-gus
BOTS ?= gambit-gus fortress-fiona

# Cross-compile bot-ds for the AMS host (linux/amd64, static) and stage an upload
# folder containing the binary + every personality's brain/style/persona. Then
# upload with the AMS CLI (replace host/client values):
#   ams upload -H <host> -c <id> -s <secret> -n bot-ds -p build/ams -e "./bot-ds"
# No --bot-id in the command line: the fleet answers for whichever personality
# the claimed session asks for.
bot-ds-build:
	rm -rf build/ams
	mkdir -p build/ams/bots
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o build/ams/bot-ds ./cmd/bot-ds
	cp -R $(addprefix bots/,$(BOTS)) build/ams/bots/
	@echo "Staged build/ams: bot-ds (linux/amd64) + bots/$(BOTS)"
	@echo "Upload: ams upload -H <host> -c <id> -s <secret> -n bot-ds -p build/ams -e \"./bot-ds\""

# Run bot-ds locally against the AMS Simulator's watchdog (download the Simulator
# from Admin Portal -> AMS -> CLI tools and start it first). BOT only sets the
# personality used for local serving and for sessions from an unmapped pool.
bot-ds-run-sim:
	go run ./cmd/bot-ds --bot-id $(BOT) --watchdog-url ws://localhost:5555/watchdog
