#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="openfeature-managed-gateway:latest"
CONTAINER_NAME="openfeature-managed-gateway"
TRAEFIK_DYNAMIC_DIR="/data/coolify/proxy/dynamic"
PERSIST_DIR="$ROOT_DIR/../data/openfeature-managed-gateway"

cd "$ROOT_DIR"

docker build -t "$IMAGE_NAME" .

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
mkdir -p "$PERSIST_DIR"

docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --network coolify \
  -e DATA_DIR=/data \
  -e PUBLIC_BASE_URL="http://openfeature-gateway.46.225.49.219.nip.io" \
  -v "$PERSIST_DIR:/data" \
  "$IMAGE_NAME" >/dev/null

cp "$ROOT_DIR/infra/openfeature-managed-gateway.traefik.yaml" "$TRAEFIK_DYNAMIC_DIR/openfeature-managed-gateway.yaml"

echo "Deployed: http://openfeature-gateway.46.225.49.219.nip.io"
