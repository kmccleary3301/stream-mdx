# StreamMDX Perf Harness

This harness streams a fixture through the real `StreamingMarkdown` renderer in the docs app and collects:
- flush metrics (`RendererMetrics`)
- long tasks (filtered to the stream window)
- rAF cadence
- optional memory samples (Chromium only)
- optional CDP performance metrics (task/script/layout/recalc/paint deltas)
- optional DOM counters (nodes/event listeners)

It is local-only by design and is intended for iterative optimization with the regression suite as a hardline behavior lock.

## Methodology contract

Keep the public benchmark story disciplined:

- parity workloads are the only direct cross-engine comparison set
- capability workloads exist to show StreamMDX behavior on richer feature mixes, not to manufacture apples-to-oranges claims
- `CI locked` is the claim-grade live mode
- `Explore` is the diagnosis mode
- shipped client bundle, hosted worker asset, runtime loaded code, and peak memory are separate cost categories

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

If you want to compare syntax highlighting modes, pass `--codeHighlighting` to the harness CLI (default is `"incremental"`). A typical workflow is:

1. Run a baseline with `--codeHighlighting final`.
2. Run a candidate with `--codeHighlighting incremental` or `--codeHighlighting live`.
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

The harness accepts `--scheduling` (`default`, `smooth`, `aggressive`) and optional overrides. If omitted, it defaults to `aggressive`.

When you translate those harness knobs into the public benchmark surface, keep only these two interpretations:

- `CI locked`: fixed scheduler behavior for reproducible local comparisons
- `Explore`: freer tuning for diagnosis, never for public claim language

Raw preset names such as `smooth` or `aggressive` are implementation details; they are not public benchmark categories on their own.

Supported raw overrides:

```
--batch microtask|timeout|rAF
--frameBudgetMs 8
--maxBatchesPerFlush 8
--lowPriorityFrameBudgetMs 4
--maxLowPriorityBatchesPerFlush 2
--urgentQueueThreshold 3
--historyLimit 200
--startupMicrotaskFlushes 4
--adaptiveBudgeting true|false
--adaptiveSwitch true|false
--adaptiveQueueThreshold 12
```

These map to `StreamingSchedulerOptions` in `@stream-mdx/react`.

Interpretation rule:

- use a fixed scheduler preset when comparing candidate vs baseline
- do not change scheduler knobs mid-comparison and then treat the result as a pure renderer win/loss
- if you need claim-grade browser comparisons, line them up with the locked methodology described in [`SCHEDULING_AND_JITTER.md`](./SCHEDULING_AND_JITTER.md)
- if you are running the rich capability workload, do not report it as a direct Streamdown/react-markdown parity result

Useful scheduler-specific commands:

```bash
npm run test:regression:scheduler-parity
STREAM_MDX_PERF_BASE_URL=http://127.0.0.1:3012 npm run perf:characterize:scheduler
```

- `test:regression:scheduler-parity` checks that representative fixtures converge to the same final HTML under `smooth`, `timeout`, and `microtask`.
- `perf:characterize:scheduler` writes a local `CI locked` vs `Explore` summary to `tmp/perf-runs/scheduler-characterization/`.

## Optional React profiler

Capture React commit durations for the `StreamingMarkdown` subtree:

```
--profiler
```

This adds `profiler actual/base` stats to the summary output.

## Optional renderer patch profiling

Enable renderer patch timing only for diagnostic runs:

```
npm run perf:harness -- --fixture naive-bayes --scenario S2_typical --patchPerf
```

The equivalent environment variable is `STREAM_MDX_PERF_PATCH_PERF=1`; direct visits to
`/perf/harness/` accept `?patchPerf=1`. Patch profiling is off by default.
Leaving the harness restores the prior `patchPerf` property if the effect still owns the
debug object; captured reports and patch metrics remain available.

`run.json` includes `samples.patchPerf.totals` and `samples.patchPerf.last`, with operation,
setProps node-type, payload-size bucket, and stage counts and durations. Stages separate
prop normalization and merging, block cloning, code metadata, and code-child normalization.
`summary.json` and `summary.txt` report patch total/apply timings and the most expensive
operation, setProps node type, and setProps stage.

The instrumentation adds timing and aggregation overhead. Keep it off for claim-grade
benchmarks and do not compare profiled runs against unprofiled baselines. These metrics
come from the StreamMDX renderer store, not Streamdown.

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

### Optional edge-like long-run gate

To include an edge-like stress scenario in the same gate command, pass `--candidateEdge`
(alias: `--candidateS6`) and provide a matching baseline path:

```
npm run perf:gate -- \
  --candidateS2 tmp/perf-runs/<s2-run> \
  --candidateS3 tmp/perf-runs/<s3-run> \
  --candidateEdge tmp/perf-runs/<table-large-s6-run> \
  --baseEdge tmp/perf-baselines/S6_extreme_edge_like \
  --gate
```

If `candidateEdge` is omitted, the edge-like gate is skipped.

## Baselines

Canonical baselines live under:

```
tmp/perf-baselines/S2_typical
tmp/perf-baselines/S3_fast_reasonable
tmp/perf-baselines/S6_extreme_edge_like (optional edge-like stress baseline)
```

## Private Node replay, work counters, and physical functional observer

Private tooling under `scripts/perf/` provides deterministic invariant verification and functional progress observation separate from production browser benchmark runs.

### Node replay oracle and work counters

The replay oracle executes in-process under Node (>=20) to verify parser, tokenization, store, and view invariants against full authored-source MDAST and independent Shiki tokens with no invented closing-fence sentinel and no carriage-return (CR) trimming:

1. Build the counter-instrumented diagnostic bundle:
   ```bash
   npx tsx scripts/perf/build-diagnostic-bundle.ts
   ```
   This compiles `scripts/perf/diagnostic-dist/index.mjs` counter-enabled (`__STREAM_MDX_COUNTERS__ = true`). In contrast, standard package and hosted worker builds MUST define `__STREAM_MDX_COUNTERS__ = false` with dead-code syntax folding.

2. Run the dense replay oracle:
   ```bash
   npx tsx scripts/perf/replay-oracle.ts --json <owned-result.json>
   ```
   Optional flags: `--fixture <id>`, `--seed <number>`, `--bail`. The script currently expects those exact identities; do NOT generalize flags it does not have.

Oracle execution and invariants:
- The oracle exits `1` on measured invariant or product divergence, and exits `2` on fatal runtime errors. It MUST NOT be treated as a skipped-green baseline.
- Verification mounts real JSDOM containers and native views (`MarkdownBlocksRenderer`, `ComponentRegistry`) to exercise real consumer work.
- It verifies cold non-finalizing prefix equality at every actual patch publication frontier, final store equality, and independent CommonMark/GFM syntax expectations.
- Attempts $N$ vs $4N$ bounded equal-size appends with bounded line width across paragraph, code, table and list. The retained baseline has measurements for paragraph, code and list only: the LF table setup is classified as a paragraph, records a block-type divergence and has no table measurement.
- Measurement excludes `FINALIZE` and enumerated backward invalidation by resetting counters after prefix setup to isolate append window work.
- Tracks eight stage counters across `engine`, `snapshot`, `patch`, `store`, and `view`:
  1. `lines_tokenized`
  2. `units_tokenized`
  3. `inline_source_units_prepared`
  4. `snapshot_nodes_built`
  5. `prefix_comparisons`
  6. `patches_emitted`
  7. `store_records_touched`
  8. `blocks_reprepared`
- A $1.25\times$ future optimized-path gate compares the sum of observed stage counters per append-window unit at $4N$ versus $N$. This is neither CPU cost nor complete source-text/view-input-volume coverage; flat view-record counts do not prove that growing text props are cheap.
- P1 records inherited reds directly into divergence reports rather than masking them.

### Physical functional progress observer

The separate functional progress observer measures streaming delivery against a live browser export:

1. Build the standalone progress observation assets:
   ```bash
   npx tsx scripts/perf/build-progress-observation.ts
   ```
   This creates only `apps/docs/out/stream-mdx-progress-observation` (`worker.js`, `browser.js`, `index.html`).

2. Run the driver against an active export server:
   ```bash
   npx tsx scripts/perf/run-progress-observation.ts
   ```
   The driver targets the existing loopback export server at `http://127.0.0.1:3012/stream-mdx-progress-observation/` and writes structured evidence to `tmp/stream-mdx-progress-observation-20261015.json`.

Driver requirements and constraints:
- Diagnostic-only functional observation; results are NOT comparable production timing.
- Requires a physical Worker (`new Worker("./worker.js", { type: "module" })`), public `handle.append`, and public `handle.onFlush`.
- Validates original semantic patch ordinals, requires actual `INITIALIZED` and `FINALIZED` lifecycle messages, and verifies semantic patch drain completion.
- Fixed workload: `code-262k` with 263 chunks dispatched on 20ms ticks (50,000 cps, $\le 1000$ chars/chunk).
- Strict driver deadlines from driver start: readiness within 30s (`READY_TIMEOUT_MS = 30_000`), total observation within 60s (`OBSERVATION_TIMEOUT_MS = 60_000`).
- Exact runtime environment: Chromium `153.0.8010.12` with Playwright `1.58.2`. NEVER infer the runtime from cache directory revisions; the script currently expects those exact identities and has no generalized flags.

### Truthful limits and missing metrics

- The frozen six production observations (`code-262k`, `table-250`, `list-500`, `finalize-253k`, `finalize-1000k`, `short-code`) have no complete engine/commit/visible mapping.
- The functional observer proves final accounted frontiers and visible prefix ranges only.
- Missing metrics are explicit and MUST NOT be assumed:
  - No per-commit latency timeline.
  - No whole-source consumer equality derived from counter values.
  - No offscreen/tail-visible or paint guarantee.
  - No worker CPU, heap, or capacity guarantees.
- Do NOT paste campaign numeric timing results.
- Inherited reds (including nested code blocks, LF table setup, CRLF table parsing, and link/footnote reference resolution) are NOT fixed and MUST NOT be characterized as resolved.

## Notes

- Memory sampling is only available in Chromium (`performance.memory`).
- CDP metrics and DOM counters come from `Performance.getMetrics` and `Memory.getDOMCounters` (Chromium only).
- This harness uses the docs worker (`/workers/markdown-worker.js`) and demo registry.
- `perf:demo` targets the `/demo` page and is separate from this harness.
- Treat shipped client bundle, hosted worker asset, runtime loaded code, and peak memory as different cost categories.
- The current public static benchmark set is intentionally five classes: four parity-friendly classes plus one explicitly marked capability stress class.
