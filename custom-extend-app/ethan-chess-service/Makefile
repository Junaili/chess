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
