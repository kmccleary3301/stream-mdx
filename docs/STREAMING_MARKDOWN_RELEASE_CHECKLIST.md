# Streaming Markdown V2 — Release Checklist

_Last updated: 2025-11-07_

Use this checklist when cutting preview builds (0.9.x) or the eventual 1.0.0 release. It assumes the workspace layout introduced in Phase 2/3/4 plus the new package build pipeline (`npm run markdown-v2:build:packages`).

---

## 1. Preflight

1. **Install deps & build worker**
   ```bash
   npm install
   npm run worker:build
   ```
2. **Run the focused suites**
   ```bash
   npm run markdown-v2:test:packages
   npm run markdown-v2:test:snippets
   npm run markdown-v2:test:patch-scheduler
   npm run markdown-v2:test:patch-coalescing
   npm run markdown-v2:bench:coalescing
   ```
   Capture JSON/CSV artifacts from `tmp/snippet_analysis/` and `tmp/renderer-benchmark.json`.
3. **Smoke the demo in both MDX modes**
   - `npm run dev`
   - Visit `/examples/streaming`, toggle **Server** and **Worker** compile modes, confirm no pending MDX blocks remain at completion.
   - Run the Puppeteer smoke test against the dev server for good measure:
     ```bash
     npm run worker:smoke -- http://127.0.0.1:3006/examples/streaming --length 400 --timeout 45000
     ```
4. **Worker helper sanity check**
   - Set `NEXT_PUBLIC_STREAMING_WORKER_HELPER=true` (and optionally `NEXT_PUBLIC_STREAMING_WORKER_HELPER_MODE=blob`) in `.env.local`.
   - Run `npm run dev:single` and load `/examples/streaming`; confirm the helper banner appears and streaming still completes in both MDX modes.
   - Execute `npm run quick-test:streaming` (or `tsx scripts/quick-test-streaming.ts`) to exercise the helper wiring + `StreamingMarkdownHandle` pause/resume flow.
5. **Packaged Playwright suite**
   - Run `npm run markdown-v2:test:playwright-packaged`. This command builds/installs the tarballs into the dev app, drops the workspace-only TS path aliases, launches the demo on port **3006**, and runs the Playwright scripts (`test-mdx-preview` server + worker, `test-streaming-mixing`). Expect ~6–8 minutes of runtime.
   - The helper banner must remain visible (the script sets `NEXT_PUBLIC_STREAMING_WORKER_HELPER=true` automatically); failures here usually mean the helper wiring regressed or the tarballs shipped stale dist files.
6. **External consumption sanity check**
   - After `npm run markdown-v2:build:packages`, pack each workspace into `tmp/release-packs/`:
     ```bash
     mkdir -p tmp/release-packs
     for pkg in core worker react plugins; do
       (cd packages/markdown-v2-$pkg && npm pack --pack-destination ../../tmp/release-packs)
     done
   ```
  - Copy `examples/streaming-markdown-starter` to a scratch dir (`tmp/release-starter`), point its dependencies to the generated tarballs (`"@stream-mdx/react": "file:../release-packs/markdown-v2-react-x.tgz"`), set `NEXT_PUBLIC_STREAMING_WORKER_HELPER=true`, and run `npm install && npm run build`. This verifies both the published shape and the helper wiring without relying on workspace-relative imports.
  - For a fully automated sweep (build packages, pack tarballs, install the starter from those tarballs, run `next build`), execute `npm run markdown-v2:release:verify`. Artifacts land in `tmp/release-verify/**`; review `tmp/release-verify/manifest.json` plus the starter build logs before tagging.

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

## 6. Docs & changelog

- Update `docs/STREAMING_MARKDOWN_V2_STATUS.md` metrics tables.
- Append release notes to `docs/STREAMING_V2_NEXT_STEPS.md` or the public changelog.
- When publishing packages, regenerate any README badges with the new version numbers.

---

## 7. Rollback plan

- Keep the previous worker bundle (`public/workers/markdown-worker.js`) committed so you can `git revert` quickly if a release regresses.
- Maintain the legacy renderer feature flag in production until V2 is battle-tested.
