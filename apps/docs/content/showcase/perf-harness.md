# Perf harness

The perf harness is the regression gate for StreamMDX rendering performance. It runs fixed fixtures through fixed scenarios and emits comparable p95 numbers for each run.

## What it validates

- First flush and patch latency under realistic streaming cadence.
- Coalescing effectiveness (how many patches are merged before commit).
- Long-task behavior on large documents and syntax-heavy code blocks.
- Stability when optional features (math/HTML/MDX) are enabled together.

## Run the harness locally

```bash
npm run perf:harness
```

For a tighter dev loop:

```bash
npm run perf:demo
```

## Typical workflow

1. Run baseline on `main`.
2. Run the same fixtures on your branch.
3. Compare metrics and confirm no material p95 regressions.
4. Record notable changes in the perf changelog.

## CI gate strategy

- Keep the benchmark fixture set versioned and deterministic.
- Fail CI only on meaningful regression thresholds, not noise-level drift.
- Always pair perf changes with at least one replay/snapshot check to guard behavior and output.

## Operational notes

- Browser and CPU variance can skew micro-benchmarks; compare relative deltas, not absolute numbers.
- If a regression appears, inspect patch burst size and syntax-highlighting workload first.
- Keep worker + React package versions aligned when validating cross-package perf.

## Next steps

- Docs: [Perf harness](/docs/perf-harness)
- Benchmarks hub: [Benchmarks](/benchmarks)
- History: [Perf quality changelog](/docs/perf-quality-changelog)
