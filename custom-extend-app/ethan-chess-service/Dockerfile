FROM --platform=$BUILDPLATFORM ubuntu:22.04 AS proto-builder

ENV DEBIAN_FRONTEND=noninteractive

ARG PROTOC_VERSION=21.9
ARG GO_VERSION=1.26.4

RUN apt-get update \
    && apt-get -y install --no-install-recommends \
    build-essential \
    ca-certificates \
    git \
    unzip \
    wget \
    && ARCH_SUFFIX=$(case "$(uname -m)" in \
        x86_64) echo "x86_64" ;; \
        aarch64) echo "aarch_64" ;; \
        *) echo "x86_64" ;; \
       esac) \
    && GOARCH_SUFFIX=$(case "$(uname -m)" in \
        x86_64) echo "amd64" ;; \
        aarch64) echo "arm64" ;; \
        *) echo "amd64" ;; \
       esac) \
    && wget -O protoc.zip https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-linux-${ARCH_SUFFIX}.zip \
    && unzip protoc.zip -d /usr/local \
    && rm protoc.zip \
    && chmod +x /usr/local/bin/protoc \
    && wget -O go.tar.gz https://go.dev/dl/go${GO_VERSION}.linux-${GOARCH_SUFFIX}.tar.gz \
    && tar -C /usr/local -xzf go.tar.gz \
    && rm go.tar.gz \
    && apt-get autoremove -y \
    && apt-get clean -y \
    && rm -rf /var/lib/apt/lists/*

ENV GOROOT=/usr/local/go
ENV GOPATH=/go
ENV PATH=$GOPATH/bin:$GOROOT/bin:$PATH

RUN go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.33.0 \
    && go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.3.0 \
    && go install github.com/grpc-ecosystem/grpc-gateway/v2/protoc-gen-grpc-gateway@v2.19.0 \
    && go install github.com/grpc-ecosystem/grpc-gateway/v2/protoc-gen-openapiv2@v2.19.0

WORKDIR /build

COPY proto.sh .
COPY pkg/proto/ pkg/proto/

RUN chmod +x proto.sh && ./proto.sh

FROM --platform=$BUILDPLATFORM golang:1.26.4 AS builder

ARG TARGETOS
ARG TARGETARCH
ARG GOOS=$TARGETOS
ARG GOARCH=$TARGETARCH
ARG CGO_ENABLED=0

WORKDIR /build

COPY go.mod go.sum ./
RUN go mod download

COPY . .
COPY --from=proto-builder /build/pkg/pb pkg/pb
COPY --from=proto-builder /build/gateway/apidocs gateway/apidocs

RUN go build -v -o /output/service ./cmd/main.go

FROM alpine:3.24.1

RUN apk add --no-cache ca-certificates
RUN addgroup -S chess && adduser -S -G chess -H -h /app chess

WORKDIR /app
RUN mkdir -p gateway/apidocs

COPY --from=proto-builder /build/gateway/apidocs gateway/apidocs
COPY --from=builder /output/service service
COPY third_party third_party
# Bot persona/style (and the seed brain.json) for the self-learning trainer.
COPY bots bots

EXPOSE 8000

USER chess

CMD ["/app/service"]
