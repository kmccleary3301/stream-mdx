#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

echo "[stream-mdx] First publish helper"
echo
echo "Requirements:"
echo "- Run this from an interactive terminal (so npm can prompt for passkey OTP)."
echo "- You should already be logged in: npm whoami"
echo

if ! npm whoami >/dev/null 2>&1; then
  echo "[stream-mdx] ERROR: Not logged into npm. Run: npm login --auth-type=web"
  exit 1
fi

echo "[stream-mdx] npm user: $(npm whoami)"
echo

publish_pkg() {
  local pkg_dir="$1"
  shift
  echo "============================================================"
  echo "[stream-mdx] Next: publish from $pkg_dir"
  echo "[stream-mdx] Command: npm publish $*"
  echo "Press Enter to run, or Ctrl-C to abort."
  read -r _

  (cd "$ROOT_DIR/$pkg_dir" && npm publish "$@")
}

verify_pkg() {
  local pkg_name="$1"
  echo
  echo "[stream-mdx] Verifying on npm registry: $pkg_name"
  npm view "$pkg_name" version || true
  echo
}

# Publish dependencies first (scoped packages require --access public on first publish).
publish_pkg "packages/markdown-v2-core" --access public
verify_pkg "@stream-mdx/core"

publish_pkg "packages/markdown-v2-plugins" --access public
verify_pkg "@stream-mdx/plugins"

publish_pkg "packages/markdown-v2-worker" --access public
verify_pkg "@stream-mdx/worker"

publish_pkg "packages/markdown-v2-react" --access public
verify_pkg "@stream-mdx/react"

# Unscoped convenience package (no --access public needed, but passkey/OTP still applies).
publish_pkg "packages/stream-mdx"
verify_pkg "stream-mdx"

echo "============================================================"
echo "[stream-mdx] Done. If you want, tag the release in git now."

