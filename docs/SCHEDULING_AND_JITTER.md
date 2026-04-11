# Scheduling And Jitter

This note documents the current scheduling controls that matter for StreamMDX latency claims and local diagnosis.

## What this is for

Use this note when you need to answer one of these questions:

- Which scheduler knobs are safe to tune?
- What is the difference between a reproducible benchmark run and an exploratory one?
- Which kinds of variance are expected, and which ones indicate a correctness problem?

## Final supported public scheduler surface

For the active plan, only two public methodology labels are supported:

- `CI locked`
- `Explore`

Lower-level knobs and preset names still exist for engineering work, but they are not separate public benchmark categories. If a result is described publicly, it should map back to one of those two labels.

## Two modes that matter

### CI locked

This is the claim-grade mode used by the live benchmark lab when reproducibility matters.

- `batch: "rAF"`
- `startupMicrotaskFlushes: 8`
- `adaptiveBudgeting: false`
- benchmark inputs locked to the shared CI profile

Use this mode when:

- comparing StreamMDX with other renderers
- refreshing benchmark screenshots or public claims
- checking for regressions that should not move with local tuning

### Explore

This is the diagnosis mode used to find cliffs, burstiness, and scheduler-sensitive variance.

- `batch: "rAF"`
- `startupMicrotaskFlushes: 4`
- `adaptiveBudgeting` left enabled
- chunking, interval, and workload knobs can be changed freely

Use this mode when:

- tracing patch-to-DOM latency spikes
- checking whether a fixture is sensitive to chunk cadence
- experimenting with repeat count, order mode, or workload profile

Do not turn Explore runs into public claim language without restating the exact non-default inputs.

## What counts as acceptable variance

These should be treated as expected performance variance, not correctness failures:

- modest changes in final latency caused by chunk size or emit interval
- throughput differences across browsers or CPU classes
- memory differences across Chromium runs on different machines

These should be treated as correctness-adjacent and investigated immediately:

- visible content divergence across seeded runs
- unstable final HTML for the same fixture + scenario
- scheduler mode changes causing dropped blocks, reordered code, or malformed tables/lists

## Runtime cost terms

The benchmark and docs surfaces use these terms intentionally:

- **Shipped client bundle**: JavaScript transferred for the route itself
- **Hosted worker asset**: the separately served worker bundle used by StreamMDX in production
- **Runtime loaded code**: everything eventually executed, including lazy chunks and the worker
- **Peak memory**: highest sampled browser memory within a run; only comparable under the same local conditions

Do not collapse these into a single "bundle size" or "memory usage" claim.

## Safe tuning guidance

If you are tuning `StreamingMarkdown.scheduling`, keep the discipline simple:

1. Use `batch: "rAF"` when smoothness and predictable paint cadence matter.
2. Reduce `startupMicrotaskFlushes` only if startup work is visibly front-loading commits.
3. Disable `adaptiveBudgeting` when you need reproducible measurements.
4. Treat `frameBudgetMs`, `lowPriorityFrameBudgetMs`, and queue thresholds as diagnosis tools, not public benchmark inputs, unless you document them explicitly.
5. Treat `smooth`, `timeout`, and `microtask` parity checks as correctness guards, not alternate public benchmark modes.

## Repeatable characterization commands

Use these commands when you need a measured local scheduler profile instead of a prose explanation.

```bash
npm run test:benchmarks:methodology
npm run test:regression:scheduler-parity
STREAM_MDX_PERF_BASE_URL=http://127.0.0.1:3012 npm run perf:characterize:scheduler
```

What each one does:

- `test:benchmarks:methodology` locks the public benchmark profile and scheduler defaults so claim-grade settings cannot drift silently.
- `test:regression:scheduler-parity` replays representative fixtures under `smooth`, `timeout`, and `microtask` scheduler presets and fails if final HTML diverges.
- `perf:characterize:scheduler` runs a small local perf matrix and writes the latest summary to `tmp/perf-runs/scheduler-characterization/`.

The characterization output is intentionally local. It is useful for deciding whether a tuning change is safe, but it is not a publishable cross-machine benchmark on its own.

## Related references

- [`PERF_HARNESS.md`](./PERF_HARNESS.md)
- [`PERFORMANCE_GUIDE.md`](./PERFORMANCE_GUIDE.md)
- [`STREAMDOWN_COMPARISON.md`](./STREAMDOWN_COMPARISON.md)
- Public benchmark surface: <https://stream-mdx.vercel.app/benchmarks>
