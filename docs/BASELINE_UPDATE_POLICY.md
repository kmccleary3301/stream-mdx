# Baseline And Snapshot Update Policy

This document defines when StreamMDX baselines may be updated, and when a baseline refresh is insufficient.

## Scope

These rules apply to:

- HTML regression snapshots under `tests/regression/snapshots/html/**`
- style regression snapshots under `tests/regression/snapshots/styles/**`
- docs snapshot artifacts under `apps/docs/.generated/snapshots/**`
- perf baselines under `tmp/perf-baselines/**` when they are used for public comparison or release notes

## Decision rule

A baseline refresh is valid only when the new output represents one of these cases:

1. an intentional product change
2. deterministic contract drift that is already explained and accepted
3. a docs/content refresh that does not weaken a correctness guarantee
4. a styling change that is explicitly part of a visual update and has been reviewed as such

A baseline refresh is **not** a fix for:

- semantic rendering bugs
- seeded replay divergence
- scheduler-mode parity failures
- correctness invariants becoming red
- stale-patch or epoch-discipline regressions

## Required pairing for correctness fixes

If a correctness bug escaped once, the fix must land with all of the following:

- one fixture
- one invariant or direct unit/integration test
- one scenario or deterministic seeded replay path

Refreshing snapshots without adding the missing guard is not sufficient.

## HTML snapshot policy

Before updating HTML snapshots, the following must be green against the intended serving model:

```bash
npm run docs:build
STREAM_MDX_REGRESSION_BASE_URL=http://127.0.0.1:<port> npm run test:regression:html
STREAM_MDX_REGRESSION_BASE_URL=http://127.0.0.1:<port> npm run test:regression:seeded-smoke
STREAM_MDX_REGRESSION_BASE_URL=http://127.0.0.1:<port> npm run test:regression:scheduler-parity
```

Use `UPDATE_SNAPSHOTS=1` only after the output change is understood.

## Style snapshot policy

Before updating style snapshots, verify:

```bash
npm run docs:build
STREAM_MDX_REGRESSION_BASE_URL=http://127.0.0.1:<port> npm run test:regression:styles
npm run test:regression:style-invariants
```

Style baselines may move for deliberate visual changes, but the accompanying change should explain:

- what moved
- why the new geometry/colors/spacing are correct
- whether any route-level screenshot review was performed

## Docs artifact policy

Generated docs snapshot artifacts under `apps/docs/.generated/snapshots/**` may be refreshed when:

- the source docs content changed
- snapshot compiler inputs changed intentionally
- the build/export contract changed intentionally

They should not be refreshed to mask route-rendering bugs.

## Perf baseline policy

Perf baselines are advisory unless a specific gate says otherwise.

When updating perf baselines used for public claims:

- use the documented claim-grade scheduler mode
- keep fixture/scenario labels unchanged unless the methodology document is updated
- update the related notes in `docs/PERF_HARNESS.md`, `docs/SCHEDULING_AND_JITTER.md`, and any public benchmark copy if interpretation changed

## Reviewer checklist

Before approving a baseline refresh, verify:

- the output drift is deterministic
- the drift is explained in the PR or commit notes
- the relevant invariant/test coverage exists
- no red correctness gate is being bypassed
- artifacts were inspected if the change originated from a failure

## Related docs

- [`REGRESSION_TESTING.md`](./REGRESSION_TESTING.md)
- [`STREAMING_CORRECTNESS_CONTRACT.md`](./STREAMING_CORRECTNESS_CONTRACT.md)
- [`STREAMING_MARKDOWN_RELEASE_CHECKLIST.md`](./STREAMING_MARKDOWN_RELEASE_CHECKLIST.md)
- [`ESCAPED_BUG_TRACEABILITY_MATRIX.md`](./ESCAPED_BUG_TRACEABILITY_MATRIX.md)
