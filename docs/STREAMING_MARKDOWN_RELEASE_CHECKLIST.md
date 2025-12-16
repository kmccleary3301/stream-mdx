# Streaming Markdown V2 — Release Checklist

_Last updated: 2025-12-16_

Use this checklist when cutting preview builds (0.9.x) or the eventual 1.0.0 release from the extracted `stream-mdx/` repo. It assumes the current workspace scripts in `stream-mdx/package.json` (not the older `ql_homepage` scripts).

---

## 1. Preflight (local)

1. **Install deps (clean)**
   ```bash
   npm ci
   ```
2. **Build packages**
   - `npm run build` runs all workspace builds (`npm -ws --if-present run build`).
   ```bash
   npm run build
   ```
3. **Build the hosted worker + copy to examples**
   ```bash
   npm run worker:build
   ```
4. **Run tests**
   ```bash
   npm test
   ```
5. **Sanity-check hosted worker outputs**
   - Built worker artifact:
     - `packages/markdown-v2-worker/dist/hosted/markdown-worker.js`
   - Copied artifact (for the example app):
     - `examples/streaming-markdown-starter/public/workers/markdown-worker.js`

---

## 2. Pack + external install gate (high signal)

This is the most reliable “will npm users succeed?” gate.

1. **Pack tarballs locally**
     ```bash
     mkdir -p tmp/release-packs
     (cd packages/markdown-v2-core && npm pack --pack-destination ../../tmp/release-packs)
     (cd packages/markdown-v2-plugins && npm pack --pack-destination ../../tmp/release-packs)
     (cd packages/markdown-v2-worker && npm pack --pack-destination ../../tmp/release-packs)
     (cd packages/markdown-v2-react && npm pack --pack-destination ../../tmp/release-packs)
     (cd packages/stream-mdx && npm pack --pack-destination ../../tmp/release-packs)
     ```
2. **In a clean scratch dir, install from tarballs and build**
   - Minimum expectation:
     - `npm install ./tmp/release-packs/*.tgz` (or explicit paths)
     - `next build` succeeds for a simple Next app using `stream-mdx` (or `@stream-mdx/react`)
   - If you use the included starter:
     - point the starter deps at the tarballs (no workspace/file links)
     - ensure it can `npm install`, `npm run worker:build`, and `npm run build`

---

## 3. Versioning & tagging (Changesets)

This repo is set up for Changesets.

1. **Add changesets for the release**
   ```bash
   npm run changeset
   ```
2. **Version packages**
   ```bash
   npm run changeset:version
   ```
3. **Commit**
   - Example:
     - `chore(release): version packages`
4. **Tag (optional but recommended)**
   - Prefer a single repo tag per release:
     - `v0.0.1` / `v0.1.0` / `v1.0.0`

---

## 4. Publish

1. **Ensure you are logged into npm**
   ```bash
   npm whoami
   ```
2. **Publish via Changesets**
   ```bash
   npm run changeset:publish
   ```
3. **Confirm all five packages are published**
   - `@stream-mdx/core`
   - `@stream-mdx/plugins`
   - `@stream-mdx/worker`
   - `@stream-mdx/react`
   - `stream-mdx`

---

## 5. CI gates (current repo)

This repo’s CI (`.github/workflows/ci.yml`) enforces:

- `npm ci`
- `npm run build`
- `npm test`
- `npm -ws --if-present pack --dry-run`

Before publishing, run the same commands locally (plus the external install gate in §2).

---

## 6. Remaining work / publication-plan gaps (if not already done)

This section is intentionally concrete for automation (Codex CLI / scripts).

1. **Add a `release:verify` script (root)**
   - Goal: fully automated “ship check” that catches the most common npm failures.
   - Requirements:
     - Builds all workspaces
     - Packs tarballs into `tmp/release-packs/`
     - Installs the starter (or a scratch project) **from tarballs** (no workspace links)
     - Runs `npm run worker:build` (or verifies the hosted worker is present) and then `next build`
     - Writes a small manifest to `tmp/release-verify/manifest.json` (versions, tarball names, node/npm versions)

2. **Phase 2 — tighten dependency boundaries**
   - Goal: `@stream-mdx/core` stays React-free; `@stream-mdx/worker` and `@stream-mdx/plugins` must not depend on React at runtime.
   - Acceptance checks:
     - `grep -R "from 'react'\\|from \\\"react\\\"" packages/markdown-v2-core/src` returns nothing.
     - `npm ls --workspaces --prod react react-dom` shows React only where expected (usually `@stream-mdx/react`, `stream-mdx`, and example apps).
     - `packages/markdown-v2-core/package.json` has **no** `react`/`react-dom` in deps/peerDeps.

3. **Phase 3 — stabilize public API + exports discipline**
   - Goal: consumers import only documented entrypoints; deep imports are either supported intentionally or blocked.
   - Tasks:
     - Verify each package’s `exports` map matches the intended surface area.
     - Decide whether any deep imports should be supported (and document them) or explicitly blocked.
     - Ensure `types` + `typesVersions` (if used) line up with `exports`.

4. **Release engineering follow-through (Changesets)**
   - Current state: `.changeset/config.json` exists and CI runs install/build/test/pack.
   - Remaining:
     - Add first changeset(s) describing the initial public release for each package.
     - Decide versioning strategy (single version vs independent) and set it in `.changeset/config.json`.
     - Add a publish workflow (optional) or document the manual publish commands and ordering.

---

## 7. Docs & release notes

- Update `docs/STREAMING_MARKDOWN_V2_STATUS.md` metrics tables.
- Publish release notes via GitHub Releases (recommended), or add a `CHANGELOG.md` if you want a file-based changelog.
- When publishing packages, regenerate any README badges with the new version numbers (if used).

---

## 8. Rollback plan

- Tag every release; rollback is typically “revert and republish as `-patch`” or “yank with `npm deprecate` + publish fix”.
- Keep the hosted worker build deterministic so it can be regenerated from tags.
