# StreamMDX Release Checklist

_Last updated: 2026-10-07_

Use this checklist when cutting releases from `stream-mdx/`. This file is the operational release path, not a historical note.

## 1. Preflight

1. Install clean dependencies.

   ```bash
   npm ci
   ```

2. Build workspaces.

   ```bash
   npm run build
   ```

3. Build the exported docs site.

   ```bash
   NEXT_PUBLIC_STREAMING_DEMO_API=true npm run docs:build
   ```

   The demo automation API must be enabled during the Next.js build. Setting this variable only on the static server does not change the exported JavaScript.

   After streaming finishes, confirm the demo shows `Completed` and `window.__STREAMING_DEMO__.getState().isFinalizing` is `false`. The snapshot's pending and scheduling preset values must also reflect state-only changes, without requiring another renderer patch.

4. Check documentation links and anchors.

   ```bash
   DOCS_CHECK_ANCHORS=1 npm run docs:check-links
   ```

## 2. Required correctness and docs gates

These are the high-signal release gates and should be green before publishing.

1. Benchmark terminology contract.

   ```bash
   npm run test:benchmarks:methodology
   ```

2. Seeded final-HTML convergence against the exported-site serving model.

   ```bash
   npm run test:regression:seeded-smoke:server
   ```

3. Scheduler-mode final-HTML parity.

   ```bash
   npm run test:regression:scheduler-parity
   ```

4. Docs quality audit.

   ```bash
   DOCS_AUDIT_BASE_URL=http://127.0.0.1:3012 npm run docs:quality:audit
   ```

5. Package tests and build-sensitive checks.

   ```bash
   npm test
   npm -ws --if-present pack --dry-run
   npm run ci:pack-smoke
   ```

6. CommonMark conformance against the committed baseline.

   ```bash
   npm run test:conformance
   ```

## 3. Merge-time local checks

These are not all CI-required, but they should be run before a release if the touched surface warrants it.

```bash
STREAM_MDX_REGRESSION_BASE_URL=http://127.0.0.1:3012 npm run test:regression:html
STREAM_MDX_REGRESSION_BASE_URL=http://127.0.0.1:3012 npm run test:regression:styles
npm run test:regression:style-invariants
```

Use the exported docs server model:

```bash
cd apps/docs/out
python3 -m http.server 3012 --bind 127.0.0.1
```

### 3.1. Pack and external install gate

This is the most reliable “will npm users succeed?” gate.

#### 3.1.1. CI-equivalent smoke test

Runs a fully automated pack+install smoke test across Node sandbox, Next.js starter, and Vite:
- Packs `stream-mdx`, core, plugins, worker, React, theme, and the optional `@stream-mdx/mermaid` and `@stream-mdx/unified` packages.
- Installs the optional packages explicitly alongside the worker engine, with the local package graph resolved through tarball dependencies and overrides. The temporary apps use no workspace links, source imports, or compatibility shims.
- Loads every advertised ESM and CJS JavaScript export on the running supported Node version, which must be >=20. This checks that runtime, not every version in the supported range.
- Executes `MermaidBlock` through React SSR in code view. Executes `createUnifiedRenderer` with `remark-gfm` and `rehype-slug`, asserting transformed HTML. Direct and inline engines parse and finalize a heading and paragraph through both public engine entries.
- Builds Next.js and Vite apps using Mermaid `codeRenderers`, the unified `blockRenderer` with those plugins, and `engine="main-thread"`. These are production bundling checks, not browser runtime proof. Mermaid SVG generation and hydrated main-thread rendering need a separate real-browser smoke.

```bash
npm run ci:pack-smoke
# Select one target:
# npm run ci:pack-smoke -- --only node
# npm run ci:pack-smoke -- --only next
# npm run ci:pack-smoke -- --only vite
# Keep successful sandboxes for browser inspection:
# KEEP_PACK_SMOKE_TMP=1 npm run ci:pack-smoke
```

If a declared export fails, compare its manifest target with the packed `dist` files. Preserve the public subpath when correcting the target. The unified adapter bundles its ESM-only pipeline dependencies so its advertised CJS entry can execute plugins, not just load a module object. Failed runs retain the sandboxes and generated verifiers for diagnosis.

#### 3.1.2. Manual pack

1. **Pack tarballs locally**
     ```bash
     mkdir -p tmp/release-packs
     (cd packages/markdown-v2-core && npm pack --pack-destination ../../tmp/release-packs)
     (cd packages/markdown-v2-plugins && npm pack --pack-destination ../../tmp/release-packs)
     (cd packages/markdown-v2-protocol && npm pack --pack-destination ../../tmp/release-packs)
     (cd packages/markdown-v2-worker && npm pack --pack-destination ../../tmp/release-packs)
     (cd packages/markdown-v2-react && npm pack --pack-destination ../../tmp/release-packs)
     (cd packages/markdown-v2-mermaid && npm pack --pack-destination ../../tmp/release-packs)
     (cd packages/markdown-v2-unified && npm pack --pack-destination ../../tmp/release-packs)
     (cd packages/markdown-v2-tui && npm pack --pack-destination ../../tmp/release-packs)
     (cd packages/theme-tailwind && npm pack --pack-destination ../../tmp/release-packs)
     (cd packages/stream-mdx && npm pack --pack-destination ../../tmp/release-packs)
     ```
2. **In a clean scratch dir, install from tarballs and build**
   - Minimum expectation:
     - `npm install ./tmp/release-packs/*.tgz` (or explicit paths)
     - `next build` succeeds for a simple Next app using `stream-mdx` (or `@stream-mdx/react`)
   - If you use the included starter:
     - point the starter deps at the tarballs (no workspace/file links)
     - ensure it can `npm install`, `npm run worker:build`, and `npm run build`

## 4. Snapshot and baseline policy

Do not refresh snapshots blindly.

Read first:

- [`BASELINE_UPDATE_POLICY.md`](./BASELINE_UPDATE_POLICY.md)

Rules:

- correctness bugs require a fixture + invariant/test + scenario or seed
- seeded-smoke and scheduler-parity failures are not fixed by snapshot refresh alone
- deterministic drift must be explained in the PR or release notes

Update commands, only after the policy is satisfied:

```bash
UPDATE_SNAPSHOTS=1 npm run test:regression:html
UPDATE_SNAPSHOTS=1 npm run test:regression:styles
```

## 5. Perf and scheduler characterization

These are release-time characterization steps, not CI-required merge gates.

```bash
npm run perf:characterize:scheduler
npm run perf:demo -- --rate 12000 --tick 5 --runs 1
```

When capturing new public-claim baselines, update the related docs:

- [`PERF_HARNESS.md`](./PERF_HARNESS.md)
- [`SCHEDULING_AND_JITTER.md`](./SCHEDULING_AND_JITTER.md)
- [`docs/perf/LOCAL_BENCHMARKS.md`](./perf/LOCAL_BENCHMARKS.md)

## 6. Packaging and publish gates

Preferred release path for the `0.5.0` cut:

1. Run the full release preflight.

   ```bash
   npm run release:prepare:v0.5.0
   ```

   Prepare-only validates every public package at `0.5.0`, including `@stream-mdx/unified`, using the publish helper's shared version assertion. It then runs `release:gates`, `npm test`, `test:conformance`, workspace pack dry-runs, and `ci:pack-smoke` without npm authentication or publishing.

   To check version alignment without running the other gates:

   ```bash
   STREAM_MDX_EXPECT_VERSION=0.5.0 bash scripts/publish-release.sh --check-versions
   ```

2. Confirm npm auth.

   ```bash
   npm whoami
   ```

   For CI publishing, configure npm Trusted Publishing:
   - Configure npm “Trusted Publisher” for:
     - `@stream-mdx/core`
     - `@stream-mdx/plugins`
     - `@stream-mdx/protocol`
     - `@stream-mdx/worker`
     - `@stream-mdx/react`
     - `@stream-mdx/mermaid`
     - `@stream-mdx/unified`
     - `@stream-mdx/tui`
     - `@stream-mdx/theme-tailwind`
     - `stream-mdx`
   - Required workflow permissions:
     - `id-token: write`
   - Workflows:
     - `.github/workflows/release.yml` (auto release PRs / publish)
     - `.github/workflows/publish.yml` (manual workflow_dispatch)

3. Publish all public packages in dependency order.

   ```bash
   npm run release:publish:v0.5.0
   ```

4. Or run the combined gate + publish flow in one interactive terminal.

   ```bash
   npm run release:v0.5.0
   ```

5. Confirm the expected packages are published:

- `@stream-mdx/core`
- `@stream-mdx/plugins`
- `@stream-mdx/protocol`
- `@stream-mdx/worker`
- `@stream-mdx/react`
- `@stream-mdx/mermaid`
- `@stream-mdx/unified`
- `@stream-mdx/tui`
- `@stream-mdx/theme-tailwind`
- `stream-mdx`

6. Changesets remains the fallback/manual path if you intentionally need to cut a different version line:

   ```bash
   npm run changeset
   npm run changeset:version
   npm run changeset:publish
   ```

## 7. Public surface verification

After publish/deploy, verify:

- docs site: <https://stream-mdx.vercel.app/docs>
- demo: <https://stream-mdx.vercel.app/demo>
- showcase: <https://stream-mdx.vercel.app/showcase>
- benchmarks: <https://stream-mdx.vercel.app/benchmarks>
- npm package README rendering for `stream-mdx`

If `stream-mdx.dev` is configured as the canonical production domain, verify the same surfaces there and ensure redirects behave intentionally.

## 8. Worker and deployment checks

Verify the hosted worker outputs expected by examples:

- built worker artifact:
  - `packages/markdown-v2-worker/dist/hosted/markdown-worker.js`
- copied example artifact:
  - `examples/streaming-markdown-starter/public/workers/markdown-worker.js`

## 9. Artifact and log triage

If a release gate fails, inspect:

- regression artifacts under `tests/regression/artifacts/**`
- managed seeded-smoke server log at `tmp/seeded-smoke/docs-server.log`
- release-gates server log at `tmp/release-gates/docs-server.log`

Do not rerun blind before inspecting the failure artifacts.

## 10. Final branch state

Before cutting the release, confirm:

- `main` is clean
- `main` is pushed
- the release commit/tag reflects the verified state
