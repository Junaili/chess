#!/bin/bash

set -eou pipefail

find_all_proto_files() {
  find "${PROTO_DIR}" -name "*.proto" -type f
}

PROTO_DIR="${1:-pkg/proto}"
OUT_DIR="${2:-pkg/pb}"
APIDOCS_DIR="${3:-gateway/apidocs}"

rm -rf "${OUT_DIR:?}"/* && mkdir -p "${OUT_DIR:?}"
rm -rf "${APIDOCS_DIR:?}"/* && mkdir -p "${APIDOCS_DIR}"

protoc \
  -I "${PROTO_DIR}" \
  --go_out="${OUT_DIR}" \
  --go_opt=paths=source_relative \
  --go-grpc_out="${OUT_DIR}" \
  --go-grpc_opt=paths=source_relative,require_unimplemented_servers=false \
  --grpc-gateway_out=logtostderr=true:"${OUT_DIR}" \
  --grpc-gateway_opt=paths=source_relative \
  $(find_all_proto_files)

protoc \
  -I "${PROTO_DIR}" \
  --openapiv2_out "${APIDOCS_DIR}" \
  --openapiv2_opt=logtostderr=true \
  "${PROTO_DIR}"/service.proto
