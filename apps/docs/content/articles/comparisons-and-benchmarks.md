# Comparisons and Benchmarks

This article is a roadmap for making fair, reproducible comparisons against other renderers (streamdown, react-markdown, or any custom pipeline). It focuses on testing methodology and on how to interpret the metrics StreamMDX records.

## What to compare

- **Time to first visible render**: first flush time with a realistic streaming scenario.
- **Total stream duration**: time until the final render is stable.
- **Stutter and jank**: long tasks and RAF delta p95.
- **Memory growth**: peak heap size over the full stream.
- **Output correctness**: HTML regression snapshots for the same fixture.

## Recommended workflow

1. Use the built-in perf harness for StreamMDX and capture baseline summaries.
2. Re-run the same fixture against competitors using their own recommended API.
3. Record identical scenarios (S2_typical, S3_fast_reasonable) and keep update interval + chunk size consistent.
4. Validate final HTML output against a baseline snapshot (even if the competitor does not match exactly).

## StreamMDX perf harness

Run from the repo root:

```bash
npx tsx scripts/perf/run-perf-harness.ts --fixture naive-bayes --scenario S2_typical --runs 3 --warmup 1 --scheduling aggressive
```

Compare candidates:

```bash
npx tsx scripts/perf/compare-perf-harness.ts --base tmp/perf-baselines/S2_typical --candidate tmp/perf-runs/<run-folder>
```

## Notes on interpretation

- **First flush** is the most user-visible latency metric.
- **Long task p95** tracks stutter; lower is better.
- **RAF p95** near 16-17ms indicates smoother animation/scrolling.
- **Memory peak** is most important for multi-stream dashboards.

## When the comparison is not apples-to-apples

If another renderer doesn't support MDX, HTML sanitization, or streaming patches, call that out. Use a "reduced" fixture if needed, but keep a second "full" fixture to show StreamMDX's complete feature coverage.
