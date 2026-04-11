# StreamMDX Release Checklist

_Last updated: 2026-04-10_

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
   npm run docs:build
   ```

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

1. Generate or review changesets.

   ```bash
   npm run changeset
   npm run changeset:version
   ```

2. Confirm npm auth.

   ```bash
   npm whoami
   ```

3. Publish via Changesets.

   ```bash
   npm run changeset:publish
   ```

4. Confirm the expected packages are published:

- `@stream-mdx/core`
- `@stream-mdx/plugins`
- `@stream-mdx/protocol`
- `@stream-mdx/worker`
- `@stream-mdx/react`
- `@stream-mdx/mermaid`
- `@stream-mdx/tui`
- `@stream-mdx/theme-tailwind`
- `stream-mdx`

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
