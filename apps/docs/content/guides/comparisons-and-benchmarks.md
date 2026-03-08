# Comparisons and Benchmarks

This article is a roadmap for making fair, reproducible comparisons against other renderers (streamdown, react-markdown, or any custom pipeline). It focuses on testing methodology and on how to interpret the metrics StreamMDX records.

## What to compare

- **Time to first visible render**: first flush time with a realistic streaming scenario.
- **Total stream duration**: time until the final render is stable.
- **Stutter and jank**: long tasks and RAF delta p95.
- **Memory growth**: peak heap size over the full stream.
- **Output correctness**: HTML regression snapshots for the same fixture.

## Recommended workflow

1. Capture StreamMDX baselines locally using the perf harness.
2. Re-run the same fixture against competitors using their recommended API.
3. Keep scenario definitions and chunk/tick sizes identical.
4. Compare deltas with the harness comparator and log results.
5. Validate final HTML output against baseline snapshots.

## Fixtures and scenarios (current local baselines)

- `naive-bayes`: `S1_slow_small`, `S2_typical`, `S4_chunky_network`
- `table-large`: `S2_typical`, `S6_extreme`

## StreamMDX perf harness

Start the docs server (required for harness runs):

```bash
NEXT_PUBLIC_STREAMING_DEMO_API=true npm run docs:dev
```

Run the harness (examples):

```bash
npm run perf:harness -- --fixture naive-bayes --scenario S1_slow_small --runs 3 --warmup 1 --out tmp/perf-baselines
npm run perf:harness -- --fixture naive-bayes --scenario S2_typical --runs 3 --warmup 1 --out tmp/perf-baselines
npm run perf:harness -- --fixture naive-bayes --scenario S4_chunky_network --runs 3 --warmup 1 --out tmp/perf-baselines
npm run perf:harness -- --fixture table-large --scenario S2_typical --runs 3 --warmup 1 --out tmp/perf-baselines
npm run perf:harness -- --fixture table-large --scenario S6_extreme --runs 3 --warmup 1 --out tmp/perf-baselines
```

Compare candidates:

```bash
npm run perf:compare -- --base tmp/perf-baselines/<baseline> --candidate tmp/perf-baselines/<candidate>
```

Record results in `/docs/perf-quality-changelog` and keep run paths up to date in `/docs/perf-harness`.

## Notes on interpretation

- **First flush** is the most user-visible latency metric.
- **Long task p95** tracks stutter; lower is better.
- **RAF p95** near 16-17ms indicates smoother animation/scrolling.
- **Memory peak** is most important for multi-stream dashboards.

## When the comparison is not apples-to-apples

If another renderer doesn't support MDX, HTML sanitization, or streaming patches, call that out. Use a "reduced" fixture if needed, but keep a second "full" fixture to show StreamMDX's complete feature coverage.
