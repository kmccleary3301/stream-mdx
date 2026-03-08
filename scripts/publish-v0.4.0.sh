#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export STREAM_MDX_EXPECT_VERSION="0.4.0"

exec "$ROOT_DIR/scripts/publish-release.sh" "$@"
