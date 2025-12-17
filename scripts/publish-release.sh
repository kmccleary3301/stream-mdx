#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

echo "[stream-mdx] Release publish helper (interactive)"
echo
echo "This script:"
echo "- Publishes in dependency order"
echo "- Skips packages already published at the same version"
echo "- Requires an interactive terminal for npm WebAuthn/passkey prompts"
echo

if ! npm whoami >/dev/null 2>&1; then
  echo "[stream-mdx] ERROR: Not logged into npm. Run: npm login --auth-type=web"
  exit 1
fi

echo "[stream-mdx] npm user: $(npm whoami)"
echo

get_local_version() {
  node -e 'const fs=require("fs"); const p=process.argv[1]; const j=JSON.parse(fs.readFileSync(p,"utf8")); process.stdout.write(j.version);' "$1"
}

get_remote_version() {
  local pkg="$1"
  npm view "$pkg" version --userconfig=/dev/null 2>/dev/null || true
}

publish_if_needed() {
  local pkg_dir="$1"
  local pkg_name="$2"
  local publish_args=("$@")
  publish_args=("${publish_args[@]:2}")

  local pkg_json="$ROOT_DIR/$pkg_dir/package.json"
  local local_version
  local remote_version
  local_version="$(get_local_version "$pkg_json")"
  remote_version="$(get_remote_version "$pkg_name")"

  echo "============================================================"
  echo "[stream-mdx] $pkg_name"
  echo "- local:  $local_version"
  echo "- remote: ${remote_version:-<none>}"

  if [ -n "$remote_version" ] && [ "$remote_version" = "$local_version" ]; then
    echo "[stream-mdx] Skip (already published)"
    return 0
  fi

  echo "[stream-mdx] Publish from: $pkg_dir"
  echo "[stream-mdx] Command: npm publish ${publish_args[*]}"
  echo "Press Enter to continue, or Ctrl-C to abort."
  read -r _

  (cd "$ROOT_DIR/$pkg_dir" && npm publish "${publish_args[@]}")
}

# Scoped packages require --access public on publish.
publish_if_needed "packages/markdown-v2-core" "@stream-mdx/core" --access public
publish_if_needed "packages/markdown-v2-plugins" "@stream-mdx/plugins" --access public
publish_if_needed "packages/markdown-v2-worker" "@stream-mdx/worker" --access public
publish_if_needed "packages/markdown-v2-react" "@stream-mdx/react" --access public

# Unscoped convenience wrapper.
publish_if_needed "packages/stream-mdx" "stream-mdx"

echo "============================================================"
echo "[stream-mdx] Done."

