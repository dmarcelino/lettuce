#!/usr/bin/env bash
#
# Build the container images in the order Compose cannot express.
#
# docker/app-server.Dockerfile is `FROM letta-app-server-base:<version>`, which
# has to exist before Compose runs. That base is built from the fork's own
# unmodified docker/Dockerfile — the fork is a build context here, never a
# patch target, so the zero-delta rule holds.
#
# Usage: bun run build-images
set -euo pipefail

UI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LETTA_CODE_DIR="${LETTA_CODE_DIR:-$UI_ROOT/../letta-code}"

# Keep in step with the default in docker/compose.yml.
LETTA_CODE_VERSION="${LETTA_CODE_VERSION:-0.30.29}"

if [[ ! -f "$LETTA_CODE_DIR/docker/Dockerfile" ]]; then
  echo "Fork not found at $LETTA_CODE_DIR (set LETTA_CODE_DIR)" >&2
  exit 1
fi

echo "==> base image: letta-app-server-base:$LETTA_CODE_VERSION"
docker build \
  --build-arg "LETTA_CODE_VERSION=$LETTA_CODE_VERSION" \
  -t "letta-app-server-base:$LETTA_CODE_VERSION" \
  -f "$LETTA_CODE_DIR/docker/Dockerfile" \
  "$LETTA_CODE_DIR"

echo "==> compose images"
LETTA_CODE_VERSION="$LETTA_CODE_VERSION" \
  docker compose -f "$UI_ROOT/docker/compose.yml" build

echo
echo "Built. Bring the stack up with:"
echo "  docker compose -f docker/compose.yml up -d"
