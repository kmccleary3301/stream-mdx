# Streaming Markdown V2 — Release Checklist

_Last updated: 2025-12-16_

Use this checklist when cutting preview builds (0.9.x) or the eventual 1.0.0 release from the extracted `stream-mdx/` repo. It assumes the current workspace scripts in `stream-mdx/package.json` (not the older `ql_homepage` scripts).

---

## 1. Preflight

1. **Install deps, build packages, build hosted worker**
   ```bash
   npm install
   npm run worker:build
   npm run build
   ```
2. **Run workspace tests**
   ```bash
   npm test
   ```
3. **Sanity-check the hosted worker artifact**
   - The hosted worker should be produced at `packages/markdown-v2-worker/dist/hosted/markdown-worker.js`.
   - The helper copies it into the starter at `examples/streaming-markdown-starter/public/workers/markdown-worker.js` (via `npm run worker:build`).
4. **External consumption sanity check (manual, until `release:verify` exists)**
   - Pack tarballs:
     ```bash
     mkdir -p tmp/release-packs
     for pkg in markdown-v2-core markdown-v2-plugins markdown-v2-worker markdown-v2-react stream-mdx; do
       (cd packages/$pkg && npm pack --pack-destination ../../tmp/release-packs)
     done
     ```
   - In a clean scratch dir, install from those tarballs and run a minimal build (or use `examples/streaming-markdown-starter` by pointing its deps at the tarballs). This is the highest-signal “will npm users succeed?” gate.

---

## 2. Build the packages

```bash
npm run markdown-v2:build:packages
```

This emits `dist/` folders for:

- `packages/markdown-v2-core`
- `packages/markdown-v2-react`
- `packages/markdown-v2-worker`
- `packages/markdown-v2-plugins`

Verify:

- `dist/**/index.js`, `index.cjs`, and `index.d.ts` exist for each package.
- Tree-shaking works: `packages/markdown-v2-plugins/dist/plugins/*` should contain individual modules.
- File sizes stay within the documented budgets (see `docs/STREAMING_MARKDOWN_V2_STATUS.md §5`).
- Copy the generated tarballs into a scratch project and ensure `npm install ./markdown-v2-react-*.tgz` works as expected (no workspace-only imports).

---

## 3. Versioning & tagging

1. Bump versions in each package `package.json`.
   - Pre-release: `0.9.x`.
   - Stable: `1.0.0`.
2. Update the example template (`examples/streaming-markdown-starter/package.json`) so it references the new versions (or keeps `file:` links for local testing).
3. Commit with a release summary:
   ```
   chore(streaming-v2): prepare 0.9.0
   ```
4. Tag and push:
   ```bash
   git tag streaming-markdown-v2@0.9.0
   git push origin streaming-markdown-v2@0.9.0
   ```

---

## 4. Publish (when ready)

> Skip until the packages are public.

```bash
cd packages/markdown-v2-core && npm publish --access public
cd ../markdown-v2-plugins && npm publish --access public
cd ../markdown-v2-worker && npm publish --access public
cd ../markdown-v2-react && npm publish --access public
```

Confirm each tarball contains only `dist/`, `package.json`, and README/LICENSE material.

---

## 5. CI guardrails to enforce

| Check | Command | Expected budget |
| --- | --- | --- |
| Coalescing reduction (snippets) | `npm run markdown-v2:test:snippets` | ≥10 % reduction, accumulator p95 ≤ 8 ms |
| Patch scheduler stats | `npm run markdown-v2:test:patch-scheduler` | Queue depth avg ≤ 1.3 / p95 ≤ 2.0 |
| Benchmark parity | `npm run markdown-v2:bench:coalescing` | Completion time ≤ baseline +5 % |
| MDX modes | Playwright smoke (server + worker) | 0 pending MDX blocks post-stream |

Push the analyzer/benchmark artifacts to CI (e.g., upload `tmp/snippet_analysis/**` and `tmp/renderer-benchmark.json`) so regressions are traceable.

---

## 8. Remaining work to delegate (publication-plan gaps)

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
     - `npm ls --workspaces --prod react react-dom` shows React only where expected (usually `@stream-mdx/react` and example apps).
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

## 6. Docs & changelog

- Update `docs/STREAMING_MARKDOWN_V2_STATUS.md` metrics tables.
- Append release notes to `docs/STREAMING_V2_NEXT_STEPS.md` or the public changelog.
- When publishing packages, regenerate any README badges with the new version numbers.

---

## 7. Rollback plan

- Keep the previous worker bundle (`public/workers/markdown-worker.js`) committed so you can `git revert` quickly if a release regresses.
- Maintain the legacy renderer feature flag in production until V2 is battle-tested.
