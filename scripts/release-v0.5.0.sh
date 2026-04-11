#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREPARE_ONLY=0

if [[ "${1:-}" == "--prepare-only" ]]; then
  PREPARE_ONLY=1
  shift
fi

cd "$ROOT_DIR"

export STREAM_MDX_EXPECT_VERSION="0.5.0"

echo "[stream-mdx] Release 0.5.0 preflight"
echo
echo "- Enforcing package version: $STREAM_MDX_EXPECT_VERSION"
echo "- Running release gates"
echo "- Running workspace pack dry-run"
echo

npm run release:gates
npm -ws --if-present pack --dry-run

if [[ "$PREPARE_ONLY" == "1" ]]; then
  echo
  echo "[stream-mdx] Prepare-only run complete."
  exit 0
fi

echo
echo "[stream-mdx] Handing off to publish helper."
exec "$ROOT_DIR/scripts/publish-release.sh" "$@"
