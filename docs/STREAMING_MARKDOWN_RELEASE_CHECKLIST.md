# StreamMDX Release Checklist

_Last updated: 2026-10-15_

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

`Completed` and `isFinalizing === false` report native worker/renderer completion only. When trusted MDX is enabled, whole-document preparation and host rendering may still be pending; release checks must observe trusted readiness separately rather than infer it from worker `FINALIZED`.

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
   The existing CI `npm run test` aggregate runs the `@stream-mdx/react` package suite, including its coalescing behavior tests. It keeps the 10% reduction minimum on the controlled case of 60 deliberately redundant title updates and asserts the exact final value `value-59`; the same suite separately replays raw, linear, and quadratic outputs through real consumer stores. Keep both checks in this aggregate rather than adding a duplicate CI invocation.


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
- Packs all ten public packages: `stream-mdx`, core, plugins, worker, React, protocol, TUI, theme, and the optional `@stream-mdx/mermaid` and `@stream-mdx/unified` packages.
- Installs the optional packages explicitly alongside the worker engine, with the local package graph resolved through tarball dependencies and overrides. The temporary apps use no workspace links, source imports, or compatibility shims.
- Loads every advertised ESM and CJS JavaScript export on the running supported Node version, which must be >=20. This checks that runtime, not every version in the supported range.
- Executes `MermaidBlock` through React SSR in code view. Executes `createUnifiedRenderer` with `remark-gfm` and `rehype-slug`, asserting transformed HTML. Direct and inline engines parse and finalize a heading and paragraph through both public engine entries.
- Installs protocol and TUI in the Node sandbox only. Both ESM and CJS consumers assert the exported protocol ID/schema version, replay real engine patches through chunked NDJSON decoding and the TUI snapshot store, compare finalized blocks with the engine renderer store, and verify snapshot replacement. Protocol and TUI are not added to the browser apps.
- Executes `@stream-mdx/worker/node`'s `compileMarkdownSnapshot` with its default physical worker, asserting authored heading/paragraph text and finalized snapshot/artifact blocks. This exercises the installed hosted bundle and thread asset with automatic compiler-owned cleanup.
- Builds Next.js and Vite apps with `engines.mermaid` from `createMermaidEngine()`, the unified adapter's `components` map, and `engine="main"`. These are production bundling checks, not browser runtime proof. `npm run p8:mermaid-smoke` covers real Mermaid SVG, view switching, isolated config, cold SSR hydration and binding cleanup in Chromium.

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

Changesets is the canonical release path for the coordinated `1.0.0` cut.

1. Read every pending `.changeset/*.md` file and the [0.5-to-1.0 migration notes](../README.md#migrating-from-050-to-100). A single major changeset must include all ten public packages listed below.

2. Apply versions and changelogs. The script also synchronizes the lockfile without package lifecycle scripts (`npm install --package-lock-only --ignore-scripts`), so the bumped workspace versions and internal dependency pins land in `package-lock.json`. `release.yml` uses the same script for its Version Packages PR.

   ```bash
   npm run changeset:version
   ```

   This release's version mutation consumes all pending changesets. Do not apply the major changeset again to an already-versioned `1.0.0` branch. Commit the resulting manifests, generated changelogs, deleted changesets, and lockfile together.

   `.changeset/config.json` sets `onlyUpdatePeerDependentsWhenOutOfRange`. Without it, a minor bump of core or React rewrites `@stream-mdx/unified`'s `^1.x` peer ranges and bumps unified a full major (for example `1.0.0` to `2.0.0`), even though unified itself has no changes. With the setting, unified is bumped only when a new core or React version falls outside its declared peer range.

3. Check the release invariants before merging:

   - All ten public package `version` fields are `1.0.0`.
   - Internal `dependencies` remain exact `1.0.0`, not workspace links or ranges.
   - `@stream-mdx/unified` declares optional peer dependencies on `@stream-mdx/core` and `@stream-mdx/react`, both at `^1.0.0`. Core and React do not declare peers on unified.
   - The lockfile records the same workspace versions and internal dependency fields. Private docs/starter workspace links remain local.
   - The generated package changelogs include both the major migration notes and the consumed feature/fix changesets.
   - Recopied hosted worker assets must come from the matching release. Mixing 0.5 workers and 1.0 renderers is not a supported upgrade.

   The version-only helper can check public package alignment without publishing:

   ```bash
   STREAM_MDX_EXPECT_VERSION=1.0.0 bash scripts/publish-release.sh --check-versions
   ```

   Version mutation is not evidence that the build, tests, or consumer gates pass. Complete the earlier checklist gates and require independent review of the exact release commit.

4. Use `.github/workflows/release.yml` on the reviewed `main` commit. It runs the configured release gates, then `changesets/action` creates a version PR when changesets remain, or runs `npm run changeset:publish` when the versioned packages are unpublished. For this already-consumed release, the latter is the intended path. Do not also dispatch a competing publisher.

   npm Trusted Publishing must be configured for each of the ten packages, with the repository, workflow filename, and `npm-publish` environment matching the selected workflow. The jobs use Node 22, npm 11, `id-token: write`, and provenance. Local npm authentication is not required for this CI path. The `release.yml` job also needs its GitHub token permissions for Changesets PRs and releases.

5. `.github/workflows/publish.yml` is a manually approved recovery path. Dispatch it only for the same reviewed, versioned commit after determining whether the normal release job already published any packages. It also uses Changesets and Trusted Publishing; authorize its workflow identity in npm before relying on it.

   **How 1.0.0 actually shipped.** Trusted Publishing was not configured, and no `release.yml` run had ever published. `1.0.0` was published by the maintainer from a clean checkout of the reviewed commit, before the release PR merged into `main`, so the workflow's `changeset:publish` then had nothing to publish:

   ```bash
   STREAM_MDX_EXPECT_VERSION=1.0.0 bash scripts/publish-release.sh --check-versions
   npm run build:packages && npm run worker:build
   npm login --auth-type=web
   STREAM_MDX_EXPECT_VERSION=1.0.0 bash scripts/publish-release.sh --yes
   npm logout
   ```

   Packages published this way carry no provenance attestation. Until Trusted Publishing is configured for all ten packages, later versions follow the same order: publish from the reviewed head of the Changesets version PR, then merge it, so the post-merge `release.yml` run finds nothing to publish.

   `publish-release.sh` requires all ten packages at one version, so it only fits coordinated cuts like `1.0.0`. A later patch or minor release bumps only the changed packages and their dependents, so the versions diverge. Publish those with Changesets, which skips versions already on npm and publishes dependencies before dependents:

   ```bash
   npm ci
   npm run build:packages && npm run worker:build
   npm login --auth-type=web
   npm run changeset:publish
   npm logout
   ```

   `changeset publish` creates a local git tag for each package it publishes (for example `@stream-mdx/worker@1.0.1`). Push those tags and create the matching GitHub releases from the package changelog sections, as was done for `1.0.0`.

6. After CI publication, confirm `1.0.0` and the intended dist-tag for every package, plus the matching GitHub release/tags:

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

The `release:*:v0.5.0` npm commands and `scripts/*v0.5.0.sh` wrappers stay as historical commands for the 0.5.0 cut. They assert that version and are not the 1.0 release path. Do not repoint them, alias them to 1.0, or add another version-specific wrapper. Future versions use the same Changesets commands and CI workflows.

Keep the all-ten-package requirement scoped to the coordinated `1.0.0` release procedure above. Later unreleased changesets should name only public packages whose surfaces actually changed. A pending changeset records unreleased scope; it does not apply versions or assert publication.

### Scope of the historical correctness contract

The 1.0 release does not claim complete implementation of every requirement in [`STREAMING_CORRECTNESS_CONTRACT.md`](./STREAMING_CORRECTNESS_CONTRACT.md). Strict monotonic `streamSeq`/`parseEpoch`/`tx` tuple validation, the complete automatic safety-mode trigger model, and all enumerated safety/correctness metrics remain inherited contract gaps, not newly proven guarantees. Record those separately from introduced behavior and API regressions during review.

The approved lookahead behavior is a bounded provisional scan with fixed declared caps, raw fallback for all provisional inputs over 512 characters, and preserved oversized finalized/nonprovisional complete content. Within-budget finalized projection retains its existing behavior. Do not describe this as "finalized content never repairs," full historical-contract compliance, or a measured speed improvement. See the [configuration notes](./CONFIGURATION.md#formatanticipation) for the declared limits.

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
