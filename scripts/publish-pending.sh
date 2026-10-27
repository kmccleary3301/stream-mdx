#!/usr/bin/env bash
# Publish a reviewed Changesets "Version Packages" PR head (branch changeset-release/main) from a clean worktree.
# Maintainer-run; see docs/STREAMING_MARKDOWN_RELEASE_CHECKLIST.md §6.
#
#   STREAM_MDX_HEAD=<sha> bash scripts/publish-pending.sh --check   # fetch, fresh worktree, npm ci, build, publish-set check, npm publish --dry-run. No login, no publish.
#   STREAM_MDX_HEAD=<sha> bash scripts/publish-pending.sh           # the above, then web login, publish, logout, verify, push tags, GitHub releases.
#
# Releases every public package whose version the head changes relative to origin/main, skipping versions already
# on npm. It uses plain `npm publish` with inherited stdio, in publish-release.sh's dependency order, so npm's
# web/passkey prompt reaches the terminal. publish-release.sh only handles coordinated cuts (all ten packages at one
# version). This script never merges the PR. Merge it afterwards; the post-merge release.yml run then finds nothing
# to publish.
#
# Env:
#   STREAM_MDX_HEAD      REQUIRED reviewed origin/changeset-release/main commit (prefix ok)
#   STREAM_MDX_REPO      stream-mdx clone (default: this script's repository)
#   STREAM_MDX_WORKDIR   scratch worktree path (default /tmp/smdx-release)
set -euo pipefail

MODE=publish
if [[ "${1:-}" == "--check" ]]; then MODE=check; elif [[ -n "${1:-}" ]]; then echo "usage: $0 [--check]" >&2; exit 2; fi

REPO="${STREAM_MDX_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
EXPECT_HEAD="${STREAM_MDX_HEAD:?set STREAM_MDX_HEAD to the reviewed Version Packages PR head}"
WORKDIR="${STREAM_MDX_WORKDIR:-/tmp/smdx-release}"
# Dependency order, copied from scripts/publish-release.sh.
ORDER="markdown-v2-core markdown-v2-plugins markdown-v2-protocol markdown-v2-worker markdown-v2-react markdown-v2-mermaid markdown-v2-unified markdown-v2-tui theme-tailwind stream-mdx"

say() { printf '\n[smdx-release] %s\n' "$*"; }
die() { printf '[smdx-release] ERROR: %s\n' "$*" >&2; exit 1; }
on_npm() { [[ -n "$(npm view "$1@$2" version --userconfig=/dev/null 2>/dev/null || true)" ]]; }
field() { node -p "require('./packages/$1/package.json').$2"; }

say "Fetching $REPO"
git -C "$REPO" fetch origin --tags --quiet
HEAD_SHA="$(git -C "$REPO" rev-parse origin/changeset-release/main)"
[[ "$HEAD_SHA" == "$EXPECT_HEAD"* ]] || die "origin/changeset-release/main is $HEAD_SHA, not the reviewed $EXPECT_HEAD. Review the new head before publishing it."
git -C "$REPO" merge-base --is-ancestor origin/main "$HEAD_SHA" || die "PR head $HEAD_SHA is not based on current origin/main; wait for release.yml to regenerate the Version Packages PR and review it."
[[ -z "$(git -C "$REPO" ls-tree --name-only "$HEAD_SHA" .changeset/ | grep -vE '\.changeset/(README\.md|config\.json)$' || true)" ]] || die "PR head still has unconsumed changesets"

if [[ -e "$WORKDIR" ]]; then
  [[ "$(git -C "$WORKDIR" rev-parse HEAD 2>/dev/null || true)" == "$HEAD_SHA" ]] || die "$WORKDIR exists and is not a checkout of $HEAD_SHA; remove it (git -C $REPO worktree remove --force $WORKDIR) and rerun."
  [[ -z "$(git -C "$WORKDIR" status --porcelain --untracked-files=no)" ]] || die "$WORKDIR has tracked changes."
else
  git -C "$REPO" worktree add --detach "$WORKDIR" "$HEAD_SHA"
fi
cd "$WORKDIR"

say "Publish set"
# RELEASE = packages whose version this head changes relative to origin/main; tags and GitHub releases are
# reconciled for all of them on every run. PENDING = the RELEASE packages not yet on npm.
RELEASE=""; PENDING=""
for dir in $ORDER; do
  name="$(field "$dir" name)"; v="$(field "$dir" version)"
  [[ "$(field "$dir" private)" != true ]] || die "$name is private"
  base_v="$(git show "origin/main:packages/$dir/package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).version))')"
  if [[ "$v" == "$base_v" ]]; then echo "  same    $name@$v"; continue; fi
  RELEASE="$RELEASE $dir"
  if on_npm "$name" "$v"; then echo "  RELEASE $name $base_v -> $v (already on npm)"; else echo "  PUBLISH $name $base_v -> $v"; PENDING="$PENDING $dir"; fi
done
[[ -n "$RELEASE" ]] || die "this head changes no package versions"
# Internal dependencies must be exact versions that are already on npm or published in this run.
node -e '
const fs=require("fs"); const dirs=process.argv[1].trim().split(/\s+/);
const local=new Map(dirs.map(d=>{const j=require(`./packages/${d}/package.json`);return [j.name,j.version];}));
let bad=0;
for (const d of dirs) { const j=require(`./packages/${d}/package.json`);
  for (const [dep,spec] of Object.entries(j.dependencies||{})) if (local.has(dep) && spec!==local.get(dep)) { console.error(`${j.name} pins ${dep}@${spec}, local is ${local.get(dep)}`); bad=1; } }
process.exit(bad);' "$ORDER" || die "internal dependency pins do not match local versions"

if [[ -n "$PENDING" ]]; then
  say "npm ci + build"
  npm ci --no-audit --no-fund
  npm run build:packages
  npm run worker:build

  say "Dry-run publish"
  for dir in $PENDING; do
    (cd "packages/$dir" && npm publish --dry-run --userconfig=/dev/null 2>&1 | grep -E 'name:|version:|total files|unpacked size')
  done
else
  say "Every release package is already on npm; only tags and GitHub releases are reconciled."
fi

if [[ "$MODE" == check ]]; then
  say "Check complete. Nothing was published. Worktree kept at $WORKDIR."
  exit 0
fi

if [[ -n "$PENDING" ]]; then
  say "npm login (approve in the browser)"
  npm login --auth-type=web
  trap 'npm logout >/dev/null 2>&1 || true' EXIT
  echo "npm user: $(npm whoami)"

  for dir in $PENDING; do
    name="$(field "$dir" name)"; v="$(field "$dir" version)"
    if on_npm "$name" "$v"; then echo "$name@$v already on npm (skip)"; continue; fi
    say "Publishing $name@$v"
    (cd "packages/$dir" && npm publish --access public)
  done

  npm logout || true
  trap - EXIT
fi

say "Verifying npm"
for dir in $RELEASE; do
  name="$(field "$dir" name)"; v="$(field "$dir" version)"
  for _ in 1 2 3 4 5 6; do on_npm "$name" "$v" && break; sleep 10; done
  on_npm "$name" "$v" || die "$name@$v not visible on npm yet; rerun this script (it skips published packages)."
  echo "$name@$v ok (latest: $(npm view "$name" version --userconfig=/dev/null))"
done

say "Tags and GitHub releases"
for dir in $RELEASE; do
  name="$(field "$dir" name)"; v="$(field "$dir" version)"; tag="$name@$v"
  git rev-parse -q --verify "refs/tags/$tag" >/dev/null || git tag "$tag" "$HEAD_SHA"
  git push origin "refs/tags/$tag"
  if gh release view "$tag" >/dev/null 2>&1; then echo "release $tag exists"; continue; fi
  notes="$(mktemp)"
  awk -v v="$v" '$0 == "## " v {f=1; next} /^## /{f=0} f' "packages/$dir/CHANGELOG.md" > "$notes"
  [[ -s "$notes" ]] || die "no $v section in packages/$dir/CHANGELOG.md"
  latest=--latest=false; [[ "$name" == stream-mdx ]] && latest=--latest
  gh release create "$tag" --verify-tag --title "$tag" --notes-file "$notes" "$latest"
  rm -f "$notes"
done

say "Done. Next: merge the Version Packages PR, then check that the post-merge release.yml run publishes nothing."
say "Remove the scratch worktree afterwards: git -C $REPO worktree remove --force $WORKDIR"
