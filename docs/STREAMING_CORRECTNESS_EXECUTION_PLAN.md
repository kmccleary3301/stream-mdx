# Streaming Correctness Execution Plan

_Last updated: 2026-03-05_

This is the execution plan derived from:

- `docs_tmp/SPRINT_1_3-4-2026_PLANNER_RESPONSE.md`
- `docs/REGRESSION_FIX_MATRIX_2026-03-04.md`
- the current dirty repo state in `stream-mdx`

This document is not aspirational. It is the working backlog and PR order for the next correctness push.

Companion correctness ledgers:

- `docs/POST_FINALIZE_MUTATION_LEDGER.md`
- `docs/ESCAPED_BUG_TRACEABILITY_MATRIX.md`

## 1) Scope

Primary goal:

- replace timing-dependent semantic rendering with contract-driven streaming correctness

Secondary goals:

- make escaped rendering failures reproducible and testable
- tighten CI around correctness, not just final snapshots
- defer broad site polish and benchmark messaging until correctness is locked

## 2) Current State

Already improved locally:

- top-level ordered/unordered list padding alignment
- nested list code indentation
- sampled math lookahead leakage

Still not locked:

- fast-stream MDX final convergence
- scheduler-sensitive divergence under extreme rates
- full intermediate-state semantic safety
- sufficiently broad deterministic regression coverage

Known repo constraint:

- the worktree is very dirty
- changes span correctness, docs, packaging, site, and CI
- correctness changes must be landed in small PRs with explicit gates

## 3) Non-Goals For The First Pass

Do not mix these into the first correctness PRs:

- broad landing-page redesign
- benchmark marketing copy
- new comparison claims
- major perf hill-climbing
- article-program expansion

Those follow after correctness and deterministic replay are green.

## 4) Workstreams

### Workstream A: Instrumentation and deterministic reproduction

Purpose:

- make current failures replayable
- expose first divergence instead of only final mismatch

Primary files:

- `packages/markdown-v2-react/src/streaming-markdown.tsx`
- `packages/markdown-v2-react/src/renderer/store.ts`
- `packages/markdown-v2-react/src/renderer/patch-commit-scheduler.ts`
- `apps/docs/components/screens/streaming-markdown-demo-v2/index.tsx`
- `scripts/regression/run-html-snapshots.ts`
- `scripts/regression/utils.ts`

Deliverables:

- deterministic replay mode
- exportable event log
- store invariant checker behind test/dev flag
- regression fixture for imaginary nested-list break

### Workstream B: Semantic correctness boundary

Purpose:

- stop letting semantic correctness depend on adaptive scheduling

Primary files:

- `packages/markdown-v2-worker/src/worker.ts`
- `packages/markdown-v2-core/src/block-snapshot.ts`
- `packages/markdown-v2-core/src/streaming/inline-streaming.ts`
- `packages/markdown-v2-react/src/renderer/store.ts`
- `packages/markdown-v2-react/src/renderer/patch-commit-scheduler.ts`
- `packages/markdown-v2-react/src/renderer/node-views.tsx`

Deliverables:

- semantic vs enrichment classification
- epoch-aware patch rejection
- atomic finalization path
- guarded code append path
- stable-prefix provisional handling for lists and tables

### Workstream C: Regression and CI ratchet

Purpose:

- prevent escaped bugs from merging again

Primary files:

- `packages/markdown-v2-core/__tests__/*`
- `packages/markdown-v2-worker/__tests__/*`
- `packages/markdown-v2-react/__tests__/*`
- `tests/regression/fixtures/*`
- `tests/regression/scenarios/*`
- `scripts/regression/run-html-snapshots.ts`
- `scripts/regression/run-style-snapshots.ts`
- `.github/workflows/ci.yml`

Deliverables:

- invariants for empty lists, code line continuity, stale patch rejection
- deterministic replay smoke command
- strict CI correctness gate
- bug-fix policy: fixture + invariant + scenario

### Workstream D: CSS and semantic style locks

Purpose:

- move current CSS fixes from "seems fixed" to "regression-locked"

Primary files:

- `apps/docs/app/globals.css`
- `apps/docs/app/prose.css`
- `tests/regression/style-targets.ts`

Deliverables:

- list marker geometry lock
- nested code block indentation lock
- footnote dark mode style lock

## 5) PR Order

This order is intentional. Do not skip ahead.

### PR 1: Deterministic replay and event logging

Includes:

- deterministic replay toggle or scenario path in demo/harness
- structured event log export
- first-divergence reporting in regression tooling
- fixture for imaginary nested-list break

Acceptance:

- one known bad scenario can be replayed deterministically
- regression output identifies first divergent transaction or checkpoint

Verification:

- `npm run test:regression:html`
- targeted replay command for the new fixture

Traceability reference:

- `docs/ESCAPED_BUG_TRACEABILITY_MATRIX.md`

### PR 2: Store invariants and guarded append path

Includes:

- store invariant checker
- append-line safety guards
- stale patch counters in renderer metrics

Acceptance:

- stale append-after-replace corruption is rejected in tests
- empty semantic list invariant exists and fails on synthetic bad input

Verification:

- relevant `@stream-mdx/react` tests
- targeted regression fixture runs

### PR 3: Worker semantic boundary and atomic finalization

Includes:

- semantic/enrichment classification
- semantic-first dispatch path
- atomic finalization semantics

Acceptance:

- deterministic replay for high-risk fixtures has stable final digests
- no partially finalized semantic state reaches renderer in tests

Verification:

- `npm -w @stream-mdx/worker test`
- deterministic replay smoke
- HTML regression subset on MDX-heavy fixtures

### PR 4: Stable-prefix list/table policy

Includes:

- list and table provisional tail logic
- prevention of committed empty nested list shells

Acceptance:

- imaginary list break fixture passes
- ordered-list fragmentation fixture passes
- table-tail integrity assertions pass

Verification:

- unit tests in `@stream-mdx/core`
- worker integration tests
- regression checkpoints for list/table fixtures

### PR 5: CI ratchet and baseline policy

Includes:

- correctness smoke command in CI
- scheduler parity gate for promoted fixtures
- benchmark methodology contract check
- strict branch gate definition
- documented baseline update policy

Acceptance:

- high-risk correctness suite runs automatically
- a fixture-only regression cannot merge without updated invariant coverage

Verification:

- CI dry run
- docs update in `docs/`

### PR 6: CSS geometry and footnote locks

Includes:

- list alignment style assertions
- nested code indentation style assertions
- footnote dark mode computed-style checks

Acceptance:

- style regressions for those surfaces are locked in light and dark themes

Verification:

- `npm run test:regression:styles`

### PR 7: Site polish and docs-shell reliability

This starts only after PRs 1-6 are green.

Includes:

- TOC/anchor integrity
- docs-shell polish
- demo "lab bench" improvements
- benchmark narrative cleanup

Acceptance:

- public routes are reliable and visually reviewed
- no placeholder content on surfaced pages

## 6) Immediate Backlog

These are the next concrete tasks to land first.

### A1

Add `tests/regression/fixtures/imaginary-empty-list.md` derived from the captured artifact.

### A2

Extend regression tooling to record:

- seed
- scheduler mode
- first divergent checkpoint
- first divergent transaction when available

### A3

Add renderer-store invariant helpers for:

- no committed empty semantic lists
- no duplicate child ids
- contiguous code line ordering

### A4

Add append safety metadata and rejection logic for code append fast paths.

### A5

Prototype semantic vs enrichment envelope split behind a flag instead of replacing the whole scheduler immediately.

## 7) Commands That Must Stay Green

Fast local gate:

```bash
npm -w @stream-mdx/core run test
npx tsx packages/markdown-v2-worker/__tests__/format-anticipation-streaming.test.ts
npx tsx packages/markdown-v2-worker/__tests__/worker-nested-code-highlight.test.ts
npm run test:regression:seeded-smoke
npm run test:regression:scheduler-parity
npm run test:benchmarks:methodology
npm run test:regression:html
npm run test:regression:styles
```

Before merge for correctness PRs:

```bash
npm run determinism:matrix
npm run determinism:html-parity
npm run docs:build
```

Note:

- keep unrelated known failures out of scope unless they block correctness work directly
- if a pre-existing failing suite is encountered, document it in the PR instead of silently weakening gates

## 8) Acceptance Standard

We are done with the first correctness tranche only when all of the following are true:

1. Known high-risk fixtures reproduce deterministically.
2. Final output for those fixtures converges identically across repeated deterministic runs.
3. Empty semantic list shells are unrepresentable in committed output.
4. Code append corruption falls back safely instead of corrupting order.
5. Finalization is semantically atomic from the renderer's perspective.
6. CI enforces the new invariants.

## 9) Deferred Until After Correctness Lock

Defer these intentionally:

- major visual redesign of home/docs/showcase/benchmarks
- claim-language rewrite for public performance pages
- new benchmark methodology presentation
- deeper performance optimization beyond safety-preserving cleanup
- article expansion program

## 10) Ownership Model

For each escaped bug or new correctness PR:

- add one fixture
- add one invariant
- add one scenario or deterministic replay path
- document the specific surface touched

This is the minimum bar for landing correctness work.
