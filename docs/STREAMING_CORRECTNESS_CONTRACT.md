# Streaming Correctness Contract

_Last updated: 2026-04-10_

This document defines the correctness rules for StreamMDX's streaming renderer.

It exists to prevent a repeat of the current failure class:

- timing-dependent final convergence
- skipped or reordered semantic content
- invalid intermediate semantic DOM
- regression suites that only catch problems after the fact

This contract is normative for:

- `packages/markdown-v2-core`
- `packages/markdown-v2-worker`
- `packages/markdown-v2-react`
- regression and determinism harnesses

Related docs:

- `docs/DETERMINISM.md`
- `docs/STATIC_SNAPSHOT_ARTIFACT_CONTRACT.md`
- `docs/PATCH_CLASSIFICATION_LEDGER.md`
- `docs/REGRESSION_FIX_MATRIX_2026-03-04.md`
- `docs/POST_FINALIZE_MUTATION_LEDGER.md`
- `docs/ESCAPED_BUG_TRACEABILITY_MATRIX.md`
- `docs/PERF_HARNESS.md`
- `docs/SCHEDULING_AND_JITTER.md`
- `docs/CORRECTNESS_GATE_RESIDUALS_2026-04-03.md`

## 1) Core Rule

If a patch changes document meaning, structure, ordering, or finalized visible content, it is a semantic commit.

Semantic commits must be:

- atomic
- ordered
- epoch-guarded
- non-stale
- deterministic under deterministic replay

Anything else is enrichment and may be delayed, coalesced, or dropped.

## 2) Semantic vs Enrichment

The audited patch-family map lives in `docs/PATCH_CLASSIFICATION_LEDGER.md`.

### Semantic commits

Semantic work includes:

- block insertion, deletion, replacement, or reorder
- list topology changes
- table structure changes
- code block line structure changes
- MDX state transitions that change visible meaning
- finalization
- any patch that can make previously committed content disappear or move

Semantic work must never depend on adaptive backpressure or frame-budget heuristics for correctness.

### Enrichment commits

Enrichment work includes:

- syntax highlighting decoration
- non-semantic metadata
- optional diagnostics
- decorative UI-only state derived from already-correct semantic output

Enrichment may be:

- coalesced
- deferred
- superseded by newer enrichment for the same block epoch
- disabled under safety mode

## 3) Block Integrity Invariants

At every committed semantic state:

1. Every committed block must be internally valid for its type.
2. No committed semantic container may exist in an invalid empty state.
3. A committed list container must not exist without committed list items unless that state is valid final markdown output.
4. A committed table row must not have a cell count that conflicts with the committed table shape.
5. A committed code block must preserve stable line ordering and contiguous line identity.
6. A committed MDX block must not silently lose content between states.

## 4) Ordering Invariants

Every semantic envelope must have a strictly monotonic identity tuple:

- `streamSeq`
- `parseEpoch`
- `tx`

The renderer must reject:

- stale epochs
- duplicate semantic transactions
- out-of-order semantic transactions from older epochs

Rejection is not a warning-only event. It is a correctness-preserving action.

## 5) Final-State Parity

When streaming input is complete and finalization has finished:

1. The final streamed semantic output must match a cold parse of the full final content.
2. This parity must hold for normalized block semantics, text content, and final HTML output.
3. No provisional nodes or pending MDX states may remain.

This is stronger than "looks right in the demo". Final parity is a release requirement.

## 6) Intermediate-State Safety

Intermediate output may be incomplete. It may not be semantically wrong.

Allowed:

- truncated paragraph tails
- provisional shells for unstable code/list/table/MDX tails
- delayed enrichment

Not allowed:

- empty hallucinated nested lists
- partially committed invalid table rows
- out-of-order committed code lines
- speculative semantic trees produced from unconfirmed lookahead boundaries

If the system is unsure, the tail remains provisional.

## 7) Stable-Prefix Rules

### Lists

- Nested list containers are committed only when they contain at least one committed item.
- Unstable tail list structure stays provisional.
- If list topology must change, the unstable region is semantically replaced as a unit.

### Tables

- Header and body rows commit only after row integrity is stable.
- Tail rows remain provisional until delimiters and cell boundaries are known.

### Code blocks

- Append-only line fast paths are allowed only when append safety is provable.
- Any non-tail mutation or ordering ambiguity falls back to semantic replace.

## 8) Lookahead Rules

Lookahead is parser-internal and context-aware.

It may:

- classify a tail as provisional
- delay commitment of unstable inline structure

It may not:

- create committed semantic identity from speculative closures
- leak invalid semantic structure into the committed DOM

Nested contexts such as list item + emphasis + math + MDX are governed by the same rule: ambiguous tails stay provisional.

## 9) Scheduler Rules

The scheduler is a correctness-preserving dispatcher, not a semantic arbiter.

### Semantic queue

- strict FIFO
- atomic apply
- no semantic splitting by frame budget
- flushed before enrichment

### Enrichment queue

- coalesced
- frame-budgeted
- droppable under load

If correctness and smoothness conflict, correctness wins.

## 10) Safety Mode

Safety mode must be available in demo, harness, and tests.

Safety mode is triggered by conditions such as:

- stale semantic patch detection
- semantic queue backlog spikes
- store invariant violations
- deterministic replay divergence

In safety mode the system may:

- disable enrichment
- force block-level semantic replacement for risky tails
- surface diagnostics

It must not silently continue with known-invalid semantics.

## 11) Required Metrics

The runtime must expose counters for:

- semantic envelope count
- enrichment envelope count
- stale patch discard count
- epoch mismatch count
- atomic semantic commit duration
- semantic queue backlog max
- enrichment drop count
- store invariant violations
- empty semantic container rejections
- code append guard rejections

These metrics support correctness, not just performance.

## 12) Required Fast Gate

The correctness fast gate must keep these command families green:

```bash
npm run test:regression:seeded-smoke
npm run test:regression:scheduler-parity
npm run test:benchmarks:methodology
```

Supporting merge-time gates still include:

```bash
npm run docs:build
npm run test:regression:html
npm run test:regression:styles
```

`seeded-smoke` owns high-risk final-HTML convergence.

`scheduler-parity` owns scheduler-mode final-HTML equivalence for the promoted fixtures.

`test:benchmarks:methodology` owns the public benchmark terminology contract so docs, site copy, and harness settings do not drift silently.

## 13) CI vs Release Discipline

CI-required guards:

- `npm run test:benchmarks:methodology`
- `npm run test:regression:scheduler-parity`
- `npm run test:regression:seeded-smoke:server`
- `npm run docs:build`
- `npm run docs:check-links`

Release-only / characterization commands:

- `npm run perf:characterize:scheduler`
- wider local perf investigations that are intended for analysis rather than merge gating

Policy and operational references:

- [`BASELINE_UPDATE_POLICY.md`](./BASELINE_UPDATE_POLICY.md)
- [`STREAMING_MARKDOWN_RELEASE_CHECKLIST.md`](./STREAMING_MARKDOWN_RELEASE_CHECKLIST.md)

The rule is simple: contract checks and parity checks belong in CI; exploratory characterization does not.

Scheduler-parity and HTML-regression failures must write inspectable artifacts under `tests/regression/artifacts/` so failures can be debugged without rerunning blind.

## 14) Required Test Gates

Every escaped bug class must map to:

- one fixture
- one invariant
- one scenario or deterministic seed

Minimum required gates:

- unit invariants
- worker integration tests
- store/scheduler integration tests
- deterministic replay
- HTML regression checkpoints
- style/computed-geometry checks for high-risk CSS surfaces

## 15) Practical Decision Rule

When evaluating a change:

- If it changes meaning, it is semantic.
- If the state is structurally unsafe, it stays provisional.
- If a patch arrives for the wrong epoch, it is discarded.
- If a test checks only final screenshots, it is not enough.

This contract is the standard for future optimization work. Optimization is allowed only when it preserves this model.
