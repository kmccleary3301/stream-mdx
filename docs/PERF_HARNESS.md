# StreamMDX Perf Harness

This harness streams a fixture through the real `StreamingMarkdown` renderer in the docs app and collects:
- flush metrics (`RendererMetrics`)
- long tasks (filtered to the stream window)
- rAF cadence
- optional memory samples (Chromium only)
- optional CDP performance metrics (task/script/layout/recalc/paint deltas)
- optional DOM counters (nodes/event listeners)

It is local-only by design and is intended for iterative optimization with the regression suite as a hardline behavior lock.

## Prereqs

Start the docs dev server (port 3000):

```
npm run perf:sync-fixtures
npm run docs:dev
```

## Run the harness

```
npm run perf:harness -- --fixture naive-bayes --scenario S2_typical --scheduling aggressive --runs 3 --warmup 1
```

If you want to compare syntax highlighting modes, add `features.codeHighlighting` to the streaming config
in the demo/harness (default is `"incremental"`). A typical workflow is:

1. Run a baseline with `codeHighlighting: "final"`.
2. Run a candidate with `codeHighlighting: "incremental"` or `"live"`.
3. Compare summaries with `perf:compare`.

Outputs land in:

```
tmp/perf-runs/<fixture>-<scenario>-<timestamp>/
  run.json
  summary.json
  summary.txt
```

## Fixtures and scenarios

- Fixtures: `tests/regression/fixtures/*.md`
- Scenarios: `tests/regression/scenarios/*.json`

Sync them into the docs public folder when fixtures change:

```
npm run perf:sync-fixtures
```

Example scenario format:

```json
{
  "id": "S2_typical",
  "label": "Typical streaming",
  "updateIntervalMs": 16,
  "charRateCps": 1200,
  "maxChunkChars": 256
}
```

## Scheduling presets

The harness accepts `--scheduling` (`default`, `smooth`, `aggressive`) and optional overrides. If omitted, it defaults to `aggressive`:

```
--batch microtask|timeout|rAF
--frameBudgetMs 8
--maxBatchesPerFlush 8
--lowPriorityFrameBudgetMs 4
--maxLowPriorityBatchesPerFlush 2
--urgentQueueThreshold 3
--historyLimit 200
--adaptiveSwitch true|false
--adaptiveQueueThreshold 12
```

These map to `StreamingSchedulerOptions` in `@stream-mdx/react`.

## Optional React profiler

Capture React commit durations for the `StreamingMarkdown` subtree:

```
--profiler
```

This adds `profiler actual/base` stats to the summary output.

## Optional CPU throttling

You can apply a CDP CPU throttle to reduce variance (Chromium only):

```
--cpuThrottle 4
```

Omit the flag to run unthrottled.

## Compare / gate perf runs

```
npm run perf:compare -- --base tmp/perf-runs/<base>/summary.json --candidate tmp/perf-runs/<cand>/summary.json
```

Add `--gate` to fail on regressions. Defaults are conservative; override per metric:

```
--durationP95MaxPct 0.1
--firstFlushP95MaxPct 0.1
--longTaskP95MaxPct 0.25
--rafP95MaxPct 0.2
--memoryPeakP95MaxPct 0.15
```

### Gate both baselines in one command

```
npm run perf:gate -- --candidateS2 tmp/perf-runs/<s2-run> --candidateS3 tmp/perf-runs/<s3-run> --gate
```

## Baselines

Canonical baselines live under:

```
tmp/perf-baselines/S2_typical
tmp/perf-baselines/S3_fast_reasonable
```

## Notes

- Memory sampling is only available in Chromium (`performance.memory`).
- CDP metrics and DOM counters come from `Performance.getMetrics` and `Memory.getDOMCounters` (Chromium only).
- This harness uses the docs worker (`/workers/markdown-worker.js`) and demo registry.
- `perf:demo` targets the `/demo` page and is separate from this harness.
