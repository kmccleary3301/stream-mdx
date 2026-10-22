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

HTML baselines lock the complete final HTML bytes, root-child hashes, and final structural signatures. Provisional checkpoint captures are diagnostic evidence, not count/order/HTML/structure equality assertions. Do not refresh snapshots to re-pin incidental partial classes, event timing, or older invalid KaTeX states.

Comparisons canonicalize inline `style` values through Chromium's `CSSStyleDeclaration.cssText` before comparing HTML or hashing root children. Declaration order, values, priorities, custom-property values, and every non-style HTML byte remain strict.

Removing a provisional byte assertion does not remove a behavior lock. Keep streaming security/math error bans, code-prefix and table/list guards, MDX state expectations, required rendered text/selectors, and explicit split-boundary assertions. The display-checkpoint fixture must render its formula at the ordinary S5 marker and converge to the complete formula and prose.

Seeded replay must actually vary marker-stripped chunks using the existing seed options. Split-marker seeded S2 requests use the ordinary S5 final oracle; unseeded S5 still tests the authored critical boundary. Same-build seed and scheduler final comparisons stay exact. Zero executed requested cases are failures, not coverage.

Missing entries in the ordinary scenario matrix must be recorded from reviewed, repaired behavior. Do not narrow eligibility, copy another scenario's snapshot, normalize final HTML broadly, or promote semantic rendering failures. Repair source behavior first, inspect final DOM/text/topology and styles, then selectively record accepted or missing baselines. Existing byte-identical finals need no re-pin just because their diagnostic checkpoints changed.

### Harness completion checkpoints

`appendAndFlush` waits for the captured worker's complete UTF-16 source frontier through its existing `DEBUG_STATE` reply, then flushes and drains the renderer and allows its DOM commit frame. The first `PATCH` or `METRICS` event is not a complete-append checkpoint: one append may span several worker parse slices. The source checkpoint does not replace semantic queue drain, `FINALIZED`, or separate decoration readiness. A DOM commit frame is not proof of compositor paint.

`restart` remounts even an empty renderer, so readiness cannot reuse the discarded worker. A restart may coalesce a pending configuration remount: `setConfig` completes against the current mounted renderer, while `waitForReady` still waits for that worker's initialization. The `complete-append-frontier` S5 fixture exercises that overlap and reads paragraph text immediately after each awaited append in the same page callback.

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
