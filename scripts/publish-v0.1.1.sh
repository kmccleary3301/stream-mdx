#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(pwd)"
if [[ ! -f "$ROOT_DIR/package.json" ]]; then
  echo "[stream-mdx] Error: run this from the repo root (package.json not found)."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[stream-mdx] Error: npm is not available in PATH."
  exit 1
fi

echo "[stream-mdx] npm user: $(npm whoami)"

echo "[stream-mdx] Publishing v0.1.1 packages (interactive OTP may be required)..."

publish_pkg() {
  local dir="$1"
  local access_flag="$2"
  echo
  echo "[stream-mdx] -> $dir"
  if [[ -n "$access_flag" ]]; then
    npm publish $access_flag
  else
    npm publish
  fi
}

# Scoped packages must be public on first publish.
cd "$ROOT_DIR/packages/markdown-v2-core"
publish_pkg "packages/markdown-v2-core" "--access public"

cd "$ROOT_DIR/packages/markdown-v2-plugins"
publish_pkg "packages/markdown-v2-plugins" "--access public"

cd "$ROOT_DIR/packages/markdown-v2-worker"
publish_pkg "packages/markdown-v2-worker" "--access public"

cd "$ROOT_DIR/packages/markdown-v2-react"
publish_pkg "packages/markdown-v2-react" "--access public"

cd "$ROOT_DIR/packages/markdown-v2-mermaid"
publish_pkg "packages/markdown-v2-mermaid" "--access public"

cd "$ROOT_DIR/packages/stream-mdx"
publish_pkg "packages/stream-mdx" ""

echo
echo "[stream-mdx] Publish complete. Verify versions with:"
echo "  npm view @stream-mdx/core version"
echo "  npm view stream-mdx version"
