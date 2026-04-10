# Escaped Bug Traceability Matrix

_Last updated: 2026-04-03_

This matrix closes the contract requirement from [`STREAMING_CORRECTNESS_CONTRACT.md`](./STREAMING_CORRECTNESS_CONTRACT.md): every escaped bug class must map to at least one fixture, one invariant, and one deterministic scenario or seed path.

This file is intentionally operational. It records the regression surfaces that have already escaped into demo/docs/public routes or into strict regression runs, and it names the exact guard rails that now own them.

## Scope

Included here:

- escaped correctness failures observed in the demo, seeded replay, or strict regression suites
- bug classes that required architectural hardening in `core`, `worker`, or `react`
- style/CSS issues only when they affect semantic readability or previously escaped visual regressions

Not included here:

- speculative future risks without a concrete repro
- broad site redesign work
- benchmark storytelling or marketing copy issues

## Bug-Class Matrix

| Bug class | Primary user-visible symptom | Fixture(s) | Invariant / assertion surface | Deterministic scenario / seed path | Direct tests |
| --- | --- | --- | --- | --- | --- |
| Empty nested list shell | Phantom nested list renders under a parent item with no committed child items | `imaginary-empty-list`, `lists-nested` | HTML harness `forbidEmptyNestedLists`; renderer empty nested list guard; committed list shell must have committed items | `imaginary-empty-list / S5_pathological_boundaries`; `lists-nested / S2_typical` | `packages/markdown-v2-react/__tests__/empty-nested-list-guard.test.tsx` |
| Ordered/unordered list fragmentation | Spurious list block split or imagined break during streaming | `lists-nested`, `imaginary-empty-list`, `edge-regressions` | list item count continuity; nested list depth normalization; streamed final HTML parity under seeded replay | `lists-nested / S2_typical` seeded smoke; `imaginary-empty-list / S5_pathological_boundaries` targeted replay | `packages/markdown-v2-react/__tests__/list-depth-normalization.test.ts`, `packages/markdown-v2-react/__tests__/store-reorder.test.ts` |
| Nested inline lookahead leakage inside list items | Raw `*` / emphasis markers leak before nested list inline parse stabilizes | `edge-regressions`, `lists-nested` | anticipated nested list inline must render semantic emphasis, not raw marker text | `edge-regressions / S2_typical`; `lists-nested / S2_typical` | `packages/markdown-v2-react/__tests__/streaming-list-anticipation.test.tsx` |
| Incomplete or structurally invalid streamed table rows | Rows render with missing cells or shape drift while streaming | `table-boundary`, `table-incremental`, `table-large`, `mdx-math-code-mixed` | `forbidIncompleteTableRows`; `forbidIncompleteTableRowsDuringStreaming`; expected column count checks | `table-boundary / S2_typical` seeded smoke; `table-incremental / S2_typical` targeted run | `packages/markdown-v2-worker/__tests__/worker-structural-regressions.test.ts` |
| Code block line-order or append corruption | Code content arrives incomplete, out of order, or mutates via unsafe append | `code-huge`, `code-highlight-incremental`, `mdx-math-code-mixed` | contiguous line ordering; append guard rejection; ambiguous code mutation falls back to semantic replace | `code-huge / S1_slow_small` seeded smoke; `code-highlight-incremental / S2_typical` targeted run | `packages/markdown-v2-react/__tests__/append-lines-guard.test.ts`, `packages/markdown-v2-react/__tests__/stale-epoch-guard.test.ts`, `packages/markdown-v2-react/__tests__/code-block-line-update.test.ts` |
| Premature terminal newline in streamed code | Intermediate code checkpoint is no longer a prefix of final code text | `code-huge`, `code-highlight-incremental` | `enforceCodeTextPrefix`; rendered frontier must align with source frontier before synthesizing terminal newline | `code-huge / S1_slow_small` seeded smoke | `packages/markdown-v2-react/__tests__/code-block-terminal-newline-guard.test.ts` |
| Finalized code HTML drift based on highlight timing | Final HTML differs depending on whether stale block HTML or line-node HTML wins the race | `code-huge`, `mdx-math-code-mixed` | finalized code must compose from canonical line-node projection when available; lazy/eager Shiki parity | `code-huge / S1_slow_small`; `mdx-math-code-mixed / S2_typical` seeded smoke | `packages/markdown-v2-react/__tests__/finalized-code-prefers-line-html.test.tsx`, `packages/markdown-v2-worker/__tests__/lazy-tokenization-parity.test.ts` |
| Stale semantic patch landing after epoch advance | Older semantic patch reopens or corrupts newer state | synthetic unit coverage plus MDX/code fixtures | stale epoch rejection counter and diagnostics; same-tx semantic convergence only | exercised during seeded replay on `mdx-transitions`, `code-huge`, `mdx-math-code-mixed`, `mdx-multi-status` | `packages/markdown-v2-react/__tests__/stale-epoch-guard.test.ts` |
| Post-finalize semantic reopening | Finalized block mutates semantically after finalize except through a guarded newer-epoch semantic transition | `code-huge`, `mdx-transitions`, `mdx-math-code-mixed` | post-finalize enrichment may update metadata only; semantic follow-up must be epoch-guarded and keep block finalized | `code-huge / S1_slow_small`; `mdx-transitions / S2_typical`; `mdx-math-code-mixed / S2_typical` | `packages/markdown-v2-worker/__tests__/worker-post-finalize-boundary.test.ts`, `packages/markdown-v2-react/__tests__/post-finalize-store-boundary.test.ts` |
| Semantic reorder without epoch advancement | Valid semantic list reorder lands but does not seal a new epoch, leaving finalized structure mutable under the old epoch | `lists-nested`, `imaginary-empty-list` plus finalized store coverage | semantic `reorder` must advance the owning block epoch; stale reorder must be rejected | `lists-nested / S2_typical` seeded smoke; targeted finalized-store stability coverage | `packages/markdown-v2-react/__tests__/finalized-semantic-stability.test.ts`, `packages/markdown-v2-react/__tests__/store-reorder.test.ts`, `packages/markdown-v2-react/__tests__/stale-epoch-guard.test.ts` |
| MDX pending/compiled/error stale-response drift | MDX status flips incorrectly, retries stale responses, or diverges across seeds | `mdx-transitions`, `mdx-components`, `mdx-math-code-mixed`, `mdx-multi-status`, `naive-bayes` | raw-signature guard; stale MDX status updates rejected; same-source compile error does not re-loop; same-id raw changes must trigger a new compile instead of reusing old in-flight work | `mdx-transitions / S2_typical` seeded smoke; `mdx-math-code-mixed / S2_typical` seeded smoke; `mdx-multi-status / S2_typical` seeded smoke | `packages/markdown-v2-worker/__tests__/worker-mdx-status-signature-guard.test.ts`, `packages/markdown-v2-react/__tests__/mdx-coordinator-store-path.test.tsx` |
| Paired MDX extraction boundary loss | MDX segments disappear or split incorrectly across append boundaries | `mdx-components`, `mdx-preview-block`, `mdx-transitions`, `mdx-math-code-mixed` | paired-MDX extraction must survive boundary slicing; compiled block count and required fragments must hold | `mdx-transitions / S2_typical`; targeted MDX fixture replays | `packages/markdown-v2-core/__tests__/mixed-content-mdx-paired.test.ts`, `packages/markdown-v2-worker/__tests__/worker-structural-regressions.test.ts` |
| Nested fenced-code indentation drift in lists | Nested code in list items keeps leading indentation/tabs and renders offset incorrectly | list/article fixtures plus style targets | core fenced-code dedent invariant; nested code layout/style checks | targeted regression/style runs on list-heavy fixtures | `packages/markdown-v2-core/__tests__/list-fenced-code-dedent.test.ts` |
| List marker geometry drift | Ordered and unordered markers misalign, especially for multi-digit ordered lists | style targets plus list fixtures | marker digit metadata contract; style regression on ordered/unordered list markers | `npm run test:regression:styles`; list-heavy fixture runs | `packages/markdown-v2-react/__tests__/list-marker-width.test.tsx` |
| Footnote dark-mode readability drift | Footnotes and backlinks become low-contrast or visually broken in dark theme | `footnotes`, article fixtures | style-target regression for `.footnotes` and adjacent typography | `npm run test:regression:styles` | style targets in `tests/regression/style-targets.ts` |

## Active Seeded-Smoke Ownership

These cases are currently promoted into the seeded smoke gate in [`scripts/regression/run-seeded-smoke.ts`](../scripts/regression/run-seeded-smoke.ts):

| Fixture | Scenario | Purpose |
| --- | --- | --- |
| `code-huge` | `S1_slow_small` | slow-rate code correctness, append safety, final code parity |
| `mdx-transitions` | `S2_typical` | async MDX convergence and stale-status handling |
| `edge-regressions` | `S2_typical` | mixed inline/math/list regression smoke |
| `lists-nested` | `S2_typical` | list stability, nested list continuity, anticipation |
| `table-boundary` | `S2_typical` | streamed table shape integrity |
| `mdx-math-code-mixed` | `S2_typical` | mixed MDX + math + code final convergence |
| `mdx-multi-status` | `S2_typical` | mixed MDX success/error convergence with code and math around multiple finalized MDX blocks |

## Coverage Gaps That Still Exist

The matrix is materially better than it was, but it is not finished. The remaining work is explicit:

1. Add a stronger ordered-list fragmentation fixture if `lists-nested` stops being representative enough.
2. Promote one more table-heavy stress case if `table-boundary` becomes too narrow for future changes.
3. Add direct style assertions for nested code-block left-edge alignment inside lists.
4. Add explicit docs-shell route/anchor regressions once that tranche starts.
5. Keep this file updated whenever a new correctness bug escapes; no bug class should be fixed without adding or updating an entry here.

## Required Update Rule

Any future correctness fix that addresses an escaped bug must update at least one of:

- this matrix
- [`STREAMING_CORRECTNESS_CONTRACT.md`](./STREAMING_CORRECTNESS_CONTRACT.md)
- [`STREAMING_CORRECTNESS_EXECUTION_PLAN.md`](./STREAMING_CORRECTNESS_EXECUTION_PLAN.md)

A correctness fix is not complete until the bug class is traceable by fixture, invariant, and deterministic path.
