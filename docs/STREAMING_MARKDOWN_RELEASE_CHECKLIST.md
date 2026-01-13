# StreamMDX — Release Checklist

_Last updated: 2025-12-17_

Use this checklist when cutting releases from the `stream-mdx/` repo. It assumes the current workspace scripts in `package.json`.

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
3. **Sourcemap policy sanity check**
   - Default: **no sourcemaps** are emitted by package builds.
   - Optional: enable sourcemaps for local debugging by setting `SOURCEMAP=1`.
   ```bash
   SOURCEMAP=1 npm run build
   ```
4. **Build the hosted worker + copy to examples**
   ```bash
   npm run worker:build
   ```
5. **Run tests**
   ```bash
   npm test
   ```
6. **Local regression baselines (local-only, recommended)**
   ```bash
   npm run test:regression:html
   npm run test:regression:styles
   ```
7. **Perf baseline capture (optional, local)**
   ```bash
   NEXT_PUBLIC_STREAMING_DEMO_API=true npm run docs:dev
   npm run perf:demo -- --rate 12000 --tick 5 --runs 1
   ```
   - Output includes a `longTasks` summary (count, total duration, max, p95).
8. **Sanity-check hosted worker outputs**
   - Built worker artifact:
     - `packages/markdown-v2-worker/dist/hosted/markdown-worker.js`
   - Copied artifact (for the example app):
     - `examples/streaming-markdown-starter/public/workers/markdown-worker.js`

---

## 2. Pack + external install gate (high signal)

This is the most reliable “will npm users succeed?” gate.

### 2.1 CI-equivalent smoke test (recommended)

Runs a fully automated pack+install+`next build` using the included starter (no workspace links):

```bash
npm run ci:pack-smoke
```

### 2.2 Manual pack (optional)

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
2. **Trusted Publishing (recommended)**
   - Configure npm “Trusted Publisher” for:
     - `@stream-mdx/core`, `@stream-mdx/plugins`, `@stream-mdx/worker`, `@stream-mdx/react`, `stream-mdx`
   - Required workflow permissions:
     - `id-token: write`
   - Workflows:
     - `.github/workflows/release.yml` (auto release PRs / publish)
     - `.github/workflows/publish.yml` (manual workflow_dispatch)

3. **Publish via Changesets**
   ```bash
   npm run changeset:publish
   ```
4. **Confirm all five packages are published**
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
- `npm run ci:pack-smoke` (pack+install+`next build`)

Before publishing, run the same commands locally (plus the external install gate in §2).

---

## 6. Post-publish checks

1. **Verify npm README renders**
   - `stream-mdx` should display `packages/stream-mdx/README.md` on npmjs.com.
2. **Verify hosted worker guidance**
   - The worker is expected at `/workers/markdown-worker.js` in most examples.
3. **Confirm Trusted Publishing works**
   - Once configured on npm, use `.github/workflows/publish.yml` (manual) or `.github/workflows/release.yml` (auto).

---

## 7. Docs & release notes

- Update `docs/STREAMING_MARKDOWN_V2_STATUS.md` as implementation details change.
- Publish release notes via GitHub Releases (recommended), or add a `CHANGELOG.md` if you want a file-based changelog.
- When publishing packages, ensure badges and docs links remain correct.

---

## 8. Rollback plan

- Tag every release; rollback is typically “revert and republish as `-patch`” or “yank with `npm deprecate` + publish fix”.
- Keep the hosted worker build deterministic so it can be regenerated from tags.
