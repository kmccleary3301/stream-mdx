#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUTO_YES="${STREAM_MDX_PUBLISH_YES:-0}"
EXPECTED_VERSION="${STREAM_MDX_EXPECT_VERSION:-}"

if [[ "${1:-}" == "--yes" ]]; then
  AUTO_YES=1
fi

cd "$ROOT_DIR"

echo "[stream-mdx] Release publish helper (interactive)"
echo
echo "This script:"
echo "- Publishes in dependency order"
echo "- Skips packages already published at the same version"
echo "- Requires an interactive terminal for npm WebAuthn/passkey prompts"
if [[ -n "$EXPECTED_VERSION" ]]; then
  echo "- Enforces expected version: $EXPECTED_VERSION"
fi
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

is_remote_newer_than_local() {
  local remote="$1"
  local local="$2"
  node -e '
const [a, b] = process.argv.slice(1);
const parse = (v) => v.split(".").map((x) => Number.parseInt(x, 10));
const [am, an, ap] = parse(a);
const [bm, bn, bp] = parse(b);
const cmp = am !== bm ? am - bm : an !== bn ? an - bn : ap - bp;
process.exit(cmp > 0 ? 0 : 1);
' "$remote" "$local"
}

assert_all_local_versions_match() {
  node -e '
const fs = require("fs");
const path = require("path");
const root = process.argv[1];
const expected = process.argv[2];
const packages = [
  "packages/markdown-v2-core/package.json",
  "packages/markdown-v2-plugins/package.json",
  "packages/markdown-v2-protocol/package.json",
  "packages/markdown-v2-worker/package.json",
  "packages/markdown-v2-react/package.json",
  "packages/markdown-v2-mermaid/package.json",
  "packages/markdown-v2-tui/package.json",
  "packages/theme-tailwind/package.json",
  "packages/stream-mdx/package.json",
];
const versions = packages.map((rel) => {
  const file = path.join(root, rel);
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  return { rel, name: json.name, version: json.version };
});
const unique = [...new Set(versions.map((v) => v.version))];
if (unique.length !== 1) {
  console.error("[stream-mdx] ERROR: Package versions are not aligned:");
  for (const v of versions) console.error(`- ${v.name}: ${v.version} (${v.rel})`);
  process.exit(1);
}
if (expected && unique[0] !== expected) {
  console.error(`[stream-mdx] ERROR: Local version ${unique[0]} does not match expected ${expected}`);
  process.exit(1);
}
console.log(`[stream-mdx] Local package version: ${unique[0]}`);
' "$ROOT_DIR" "$EXPECTED_VERSION"
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

  if [ -n "$EXPECTED_VERSION" ] && [ "$local_version" != "$EXPECTED_VERSION" ]; then
    echo "[stream-mdx] ERROR: $pkg_name local version ($local_version) != expected ($EXPECTED_VERSION)"
    exit 1
  fi

  if [ -n "$remote_version" ] && [ "$remote_version" = "$local_version" ]; then
    echo "[stream-mdx] Skip (already published)"
    return 0
  fi

  if [ -n "$remote_version" ] && is_remote_newer_than_local "$remote_version" "$local_version"; then
    echo "[stream-mdx] ERROR: Remote version $remote_version is newer than local $local_version"
    exit 1
  fi

  echo "[stream-mdx] Publish from: $pkg_dir"
  echo "[stream-mdx] Command: npm publish ${publish_args[*]}"
  if [ "$AUTO_YES" != "1" ]; then
    echo "Press Enter to continue, or Ctrl-C to abort."
    read -r _
  fi

  (cd "$ROOT_DIR/$pkg_dir" && npm publish "${publish_args[@]}")
}

# Scoped packages require --access public on first publish.
assert_all_local_versions_match

publish_if_needed "packages/markdown-v2-core" "@stream-mdx/core" --access public
publish_if_needed "packages/markdown-v2-plugins" "@stream-mdx/plugins" --access public
publish_if_needed "packages/markdown-v2-protocol" "@stream-mdx/protocol" --access public
publish_if_needed "packages/markdown-v2-worker" "@stream-mdx/worker" --access public
publish_if_needed "packages/markdown-v2-react" "@stream-mdx/react" --access public
publish_if_needed "packages/markdown-v2-mermaid" "@stream-mdx/mermaid" --access public
publish_if_needed "packages/markdown-v2-tui" "@stream-mdx/tui" --access public
publish_if_needed "packages/theme-tailwind" "@stream-mdx/theme-tailwind" --access public

# Unscoped convenience wrapper.
publish_if_needed "packages/stream-mdx" "stream-mdx"

echo "============================================================"
echo "[stream-mdx] Done."
