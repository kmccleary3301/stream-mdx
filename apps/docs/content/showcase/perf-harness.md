# Perf harness

The perf harness is the reproducible way to measure StreamMDX behavior before and after changes.

It is designed to answer one question quickly: **did this change make streaming better, worse, or unchanged?**

## What this showcases

- Fixed fixture input and deterministic run settings.
- A stable metric set you can compare across commits.
- A release gate pattern for preventing silent regressions.

## Core metrics

| Metric | Why it matters | Typical target |
| --- | --- | --- |
| First flush (ms) | Time to first visible content | Lower is better |
| Patch p95 (ms) | Tail update latency under stream load | Lower is better |
| Long tasks | Main-thread jank indicator | Near zero |
| Coalescing (%) | How much patch merging reduced churn | Stable range |
| Memory (peak) | Risk of runaway allocations | No upward drift |

## Standard run matrix

Use the same matrix for every benchmark pass so results stay comparable:

- Fixture: Naive Bayes article (default demo fixture)
- Rate: `12000` chars/s
- Tick: `5` ms
- Runs: `3`
- Theme: both light and dark

## Capture workflow

1. Build worker + docs assets.
2. Start docs with automation API enabled.
3. Capture a baseline JSON.
4. Apply your change.
5. Capture candidate JSON.
6. Diff baseline vs candidate.

```bash
NEXT_PUBLIC_STREAMING_DEMO_API=true npm run docs:dev
npm run perf:demo -- --rate 12000 --tick 5 --runs 3 --out tmp/perf-baseline/main.json
npm run perf:demo -- --rate 12000 --tick 5 --runs 3 --out tmp/perf-baseline/candidate.json
```

## Regression policy

A practical default policy for release readiness:

- Fail if first flush regresses by more than `15%`.
- Fail if patch p95 regresses by more than `20%`.
- Fail if long-task count increases by more than `2x`.
- Warn (but do not fail) on memory increase under `10%`.

## Example comparison output

```json
{
  "scenario": "naive-bayes-default",
  "baseline": { "firstFlushMs": 32, "patchP95Ms": 4.1, "longTasks": 0 },
  "candidate": { "firstFlushMs": 35, "patchP95Ms": 4.6, "longTasks": 0 },
  "result": { "status": "pass", "notes": ["within thresholds"] }
}
```

## Common failure patterns

- **Large syntax/highlight updates**: patch p95 spikes after code-heavy sections.
- **Over-eager UI effects**: long tasks increase during stream bursts.
- **Unbounded plugin work**: memory climbs per run.

When this happens, test with one feature disabled at a time (`math`, `mdx`, `html`) to isolate cost.

## Guardrails for CI

- Run perf harness on PRs that touch `packages/*` or docs renderer code.
- Store baseline in source control or artifact storage with commit metadata.
- Require explicit approval when metrics exceed thresholds.

## Next steps

- Benchmarks hub: [Benchmarks](/benchmarks)
- Integration guide: [Perf harness](/docs/perf-harness)
- Change log discipline: [Perf quality changelog](/docs/perf-quality-changelog)
