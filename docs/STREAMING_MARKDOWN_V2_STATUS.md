# Streaming Markdown V2 Handbook

_Last updated: 2025-11-06_

This handbook captures the current state of the streaming Markdown/MDX renderer ("V2") and the guardrails we have in place after the Phase 4 cleanup. It is the single reference engineers should reach for when triaging regressions, tuning performance, or onboarding to the project.

## 1. Project Summary

- **Objective:** Replace the legacy synchronous renderer with a worker-driven pipeline that can parse Markdown/MDX incrementally, stream patches into React, and hydrate custom components without duplicate content or security regressions.
- **Motivation:** The previous implementation mixed parsing and rendering on the main thread, produced stale snapshots under streaming loads, and did not expose telemetry. V2 introduces deterministic snapshots, explicit patch semantics, and shared instrumentation so we can reason about performance.
- **Scope of this pass:** Stabilise renderer correctness (lists, headings, MDX), wire adaptive back-pressure, extract reusable helpers, add regression coverage, and document the system end-to-end.

## 2. Pipeline Overview

### 2.1 Worker (`lib/markdown-v2/worker.ts`)

- Parses Markdown with Lezer, enriches inline segments, highlights code via Shiki, and sanitises inline/HTML nodes in the worker thread.
- Emits `PATCH` messages containing structural diffs; heavy operations (e.g. code block reflows, MDX compilation) are tracked for telemetry.
- Applies back-pressure based on UI credits (see §3). Heavy patches are deferred when the UI indicates it is saturated.

### 2.2 Renderer Store (`lib/markdown-v2/renderer/store.ts`)

- Maintains a tree of `NodeRecord`s backed by immutable `Block` snapshots.
- Normalises list metadata via `normalizeAllListDepths` (now extracted to `renderer/list-utils.ts`) so list and list-item nodes expose `props.depth` for styling and future virtualization.
- Exposes `getNodeWithVersion` / `getChildrenWithVersion` to React hooks so components can subscribe without spurious renders.

### 2.3 Patch Scheduler (`lib/markdown-v2/renderer/patch-commit-scheduler.ts`)

- Batches patches into high/low priority lanes and flushes inside a configurable frame budget (currently 9 ms for high-priority work, 4 ms for low-priority bursts, up to 5/3 batches respectively).
- Reports `queueDepthBefore`, `remainingQueueSize`, and timing stats per flush. These feed telemetry and the back-pressure loop.
- Coalesces each batch with the new **linear accumulator** (`coalescePatchesLinear`), which collapses consecutive `appendLines`, merges `setProps` into `setPropsBatch`, and deduplicates redundant `setProps`. The old quadratic walker is still available behind `V2_USE_LINEAR_COALESCING=false` for bisecting.
- Flush results now expose both the **input** (`patchCount`) and **applied** (`appliedPatchCount`) ops per batch plus a `coalescing` payload. The demo aggregates these into `coalescingTotals` so we can monitor reduction ratios live.

### 2.4 MDX Pipeline

- Worker detects MDX blocks, emits `mdx` metadata, and listens for `MDX_COMPILED` / `MDX_ERROR` messages from the demo API.
- Two compilation strategies are now supported:
  - **Server** (default): worker streams metadata; `/api/mdx-compile-v2` returns compiled modules and caches them in-memory.
  - **Worker** (opt-in): worker compiles MDX inline using `@mdx-js/mdx`, caches modules locally, and pushes them through the patch stream (no network round-trips). Select via `RendererConfig.mdx.compileStrategy`, the demo automation API (`setMdxStrategy`), or the `MDX_COMPILE_MODE` env used by tests.
- `mdx-client.ts` registers Preview/EnhancedImage/YouTube and now accepts inline modules (`registerInlineMdxModule`) so the renderer can hydrate worker-compiled content without hitting the API.
- MDX block views expose `data-mdx-status="pending|compiled|error"` to aid QA/Playwright assertions.

## 3. Back-pressure & Scheduling

We now centralise the tuning knobs in `lib/markdown-v2/perf/backpressure.ts`:

| Setting | Value | Rationale |
| --- | --- | --- |
| `targetQueueDepth` | **1.25** | Credits stay at 1 while queue depth ≤ 1.25 (near-empty).
| `maxQueueDepth` | **3** | Credits fall to 0 when queue depth ≥ 3, throttling worker output.
| `smoothingFactor` | **0.7** | Blends previous and raw credit to prevent oscillation while still reacting quickly.
| `maxHeavyPatchBudget` | **4** | Caps heavy patches per flush when credits recover.
| `lowCreditCutoff` | **0.5** | Heavy patches are fully deferred when credits drop below 0.5.

The UI computes smoothed credits per flush (`calculateSmoothedCredit`), clamps updates to 0.01 granularity, and pushes them to the worker via `SET_CREDITS`. The worker uses the same config to derive heavy patch quotas (`computeHeavyPatchBudget`).

When tuning these knobs locally, run `npm run markdown-v2:test:backpressure`; the test feeds 1 500 randomized queue-depth samples through the calculator, asserts that simulated `RendererMetrics` only enter adaptive mode when credits collapse, and fails if heavy patch budgets violate the table above.

**Telemetry impact (latest run, `scripts/benchmark-renderers.ts`):**

- Patch→DOM p95: **2.6 ms**
- Queue depth: **avg 1.22**, **p95 4.00**, **max 7.00** (see §6 for interpretation)
- TTFMC: **~210 ms**

While p95 queue depth is still above the aspirational ≤2 target, the stricter config prevents runaway heavy batches and keeps the average below 1.5. The remaining burstiness comes from concentrated text patches; the next iteration will explore dynamic flushes or idle callbacks to drain residual batches.

## 4. Lists & Depth Metadata

- Worker snapshots now attach `props.depth` to list/list-item nodes (`block-snapshot.ts`).
- Renderer store enforces depth invariants after every structural mutation (insert, delete, reorder, setProps) using the shared `normalizeAllListDepths` helper.
- React views (`renderer/node-views.tsx`) rely solely on `props.depth`, eliminating the manual `depth` parameter threading and preparing the ground for virtualization hooks.
- Regression coverage: `markdown-v2:test:list-depth` asserts depths across nested lists before/after reorder operations; `markdown-v2:test:list-snapshot` guards the snapshot structure itself.

## 5. Testing & Tooling

### 5.1 Unit / Integration Scripts
- `npm run markdown-v2:test` – runs the package suites (`@markdown-v2-{core,react,worker}`) followed by the snippet analyzer. Use this as the default regression entry point; legacy `lib/markdown-v2/tests/*` scripts have been retired.
- `npm run markdown-v2:test:backpressure` – validates credit mapping and heavy patch budgets.
- `npm run markdown-v2:test:coalescing-property` – randomized patch-stream fuzzing that ensures `coalescePatchesWithMetrics` never drops appended lines or final props while still reducing patch counts. Seeds/blocks are logged so failures can be replayed.
- `npm run markdown-v2:test:list-depth` – ensures depth metadata survives reorders.
- `npm run markdown-v2:test:patch-scheduler` – checks scheduler batching semantics.
- `npm run markdown-v2:test:store-reorder` – confirms store updates touch the correct nodes after reorders.
- `npm run markdown-v2:test:mdx-preview` – Playwright regression for `<Preview>` blocks; honours `MDX_COMPILE_MODE` (`server`/`worker`).
- `npm run markdown-v2:test:snippets` – convenience wrapper around the snippet analyzer (`scripts/analyze-test-snippets.ts`).

### 5.2 Playwright & Benchmark Harness
- `npx tsx scripts/analyze-test-snippets.ts` – renders snippets in the demo harness (Markdown + MDX), captures HTML/telemetry, and writes JSON reports to `tmp/snippet_analysis/`. Supports `SNIPPET_FILTER`, `SNIPPET_SKIP`, and `MDX_COMPILE_MODE`.
  - `--min-coalescing-reduction=<percent>` defaults to **10**; each snippet fails with `FAIL` output if total reduction drops below this percentage (set to `0` to disable).
  - `--max-coalescing-duration=<ms>` defaults to **8**; enforces a coalescing-accumulator p95 duration guardrail (0 disables, warnings fire when telemetry is missing).
  - Each run also writes `tmp/snippet_analysis/coalescing.csv` capturing every flush batch (snippet, tx, queue delay, input/output, merged ops, duration) so regressions can be diffed line-by-line.
  - Guardrail results are persisted to `tmp/snippet_analysis/guardrails.json` and summarized in `tmp/snippet_analysis/artifacts.json → guardrails`. The GitHub Action reads those files after uploading artifacts, so HTML/CSV assets always survive even when guardrails fail.
  - Temporary suppressions live in `config/analyzer-suppressions.json` (override path with `SNIPPET_ANALYZER_SUPPRESSIONS`). Each entry must specify `snippet` (filename), `rule` (see table below), `reason`, and an optional ISO `expiresOn`. Suppressed entries show up as suggestions in the Markdown summary; expired/invalid entries are ignored automatically.
- `npm run markdown-v2:test:playwright-packaged` – builds the packages, packs tarballs, installs them temporarily into the demo app (dropping the TypeScript path aliases), starts `npm run dev:single` on port **3006**, and runs the Playwright scripts (`test-mdx-preview` for server + worker, `test-streaming-mixing`). Cleans up the temporary installs and restores `tsconfig.json` afterward.
- `npx tsx scripts/benchmark-renderers.ts` – compares V2 vs legacy streaming; outputs metrics to `tmp/renderer-benchmark.json`.
  - `--min-coalescing-reduction=<percent>` defaults to **5** for the V2 scenario; throws when the aggregated reduction dips below the guardrail.
  - `--max-coalescing-duration=<ms>` defaults to **8** and watches the flush accumulator p95 across all batches before failing CI.
- `BENCH_MDX_MODE=worker npx tsx scripts/benchmark-renderers.ts` – forces the V2 scenario to use inline compilation so you can capture parity metrics.
- When modifying worker code, always run `npm run worker:build` prior to Playwright/benchmark runs to keep the `public/workers/markdown-worker.js` bundle aligned.

#### Guardrail rules

| Rule ID | Trigger |
| --- | --- |
| `coalescing/reduction/missing-totals` | Telemetry did not expose coalescing totals (usually indicates instrumentation failure). |
| `coalescing/reduction/invalid` | Reduction metric could not be parsed. |
| `coalescing/reduction/no-coalescable` | No coalescable ops were observed. |
| `coalescing/reduction/sample-too-small` | Total input ops \< 50, so the reduction guardrail is skipped. |
| `coalescing/reduction/threshold` | Reduction percentage dipped below `--min-coalescing-reduction`. |
| `coalescing/duration/no-samples` | No duration samples were collected. |
| `coalescing/duration/threshold` | p95 duration exceeded `--max-coalescing-duration`. |

Warnings now promote to hard failures unless a matching suppression is present, so local/CI runs halt whenever a snippet regresses.

### 5.3 Dev Server Notes
- `npm run dev` spawns the worker bundler and Next.js dev server on port **3006**.

### 5.4 Automation API availability

- `window.__STREAMING_DEMO__` is now attached **only** during development builds. Preview/production builds must opt in explicitly via `NEXT_PUBLIC_STREAMING_DEMO_API=true` if a QA run still needs the shim.
- The streaming demo renders a yellow callout explaining that the shim is demo-only; the console also logs a warning pointing to this handbook. External integrations must rely on the `StreamingMarkdownHandle` ref.
- Capture scripts (`scripts/quick-test-streaming.ts`, StageRunner harnesses) continue to run against `next dev`/`npm run dev:single`, so no changes are required there. If you truly need the shim in another environment, set the env var above and document why in your PR notes.

### 5.5 Worker helper & CSP matrix

- `createDefaultWorker(options)` (exported from `@stream-mdx/worker`) is the canonical way to instantiate the V2 worker bundle. It first looks for an inline `<script data-markdown-v2-worker-source>` (Blob mode), then for `<script data-markdown-v2-worker-url>` / `<meta name="markdown-v2:worker" content="...">`, and finally falls back to `/workers/markdown-worker.js`.
- Supported modes:

| Mode | When to use | Notes |
| --- | --- | --- |
| `auto` (default) | Local dev, permissive CSP. | Uses inline source when available, otherwise the hosted URL. |
| `hosted` | Strict CSP (no `blob:`). | Instantiate from `url` only. |
| `blob` | Tests or self-contained bundles. | Requires `inlineSource` or `<script data-markdown-v2-worker-source>`; revokes Blob URLs via `releaseDefaultWorker`. |

- The demo and starter templates enable the helper when `NEXT_PUBLIC_STREAMING_WORKER_HELPER=true`, which exercises the same code consumers will run. Keep that env var in `.env.local` if you want to validate Blob vs. hosted behavior manually.

## 6. 2025-11-03 Performance Tune-Up

_Status owner: current sprint_

### 6.1 New Telemetry Hooks

- Worker metrics now record `appendLineBatches`, `appendLineTotalLines`, and `appendLineMaxLines` whenever we emit `appendLines` patches. These surface in both patch metrics and the streamed `METRICS` feed.
- The demo’s automation API exposes a flush batch log (`flushBatches`) that captures per-batch `queueDelayMs`, `durationMs`, `priority`, and the originating `tx`. `scripts/analyze-test-snippets.ts` persists this alongside existing summaries so queue depth spikes can be traced back to specific flushes.
- The sidebar now includes a dedicated Coalescing card with sparklines for reduction % and accumulator duration, color-coded thresholds (reduction ≥5 %, duration ≤5 ms), and a reset action that clears totals without restarting the stream; the panel also shows the latest batches with inline warnings.
- The scheduler now exposes an **adaptive budget** badge: once coalescing p95 exceeds 6 ms we halve the batch caps until it falls back under 4 ms. The badge and associated metrics (`coalescingDurationP95`, `coalescingSampleCount`, `adaptiveBudgetActive`) are returned via `window.__STREAMING_DEMO__.getPerf()` and surfaced in the analyzer/benchmark harnesses.

Nightly baseline automation (`npm run markdown-v2:nightly`, also wired into `markdown-v2-nightly` CI) now runs the smoke + analyzer suite, builds the production bundle, runs the benchmark harness, and copies `tmp/snippet_analysis`/`tmp/renderer-benchmark.json` into `tmp/nightly-baseline/<timestamp>/`. Inspect those manifests when chasing slow drifts instead of re-running everything manually.

### 6.2 Scheduler & Diff Heuristics

- Small `appendLines` batches (≤4 lines) are treated as **light** patches, keeping them on the high-priority lane and bypassing deferred queues.
- Patch coalescing now drops superseded `setProps` operations within the flush window, preventing redundant list-item updates from re-enqueuing.
- Code-block reconciliation short-circuits when we append at the tail: existing lines are no longer renormalised and the expensive `normalizeCodeBlockChildren` pass is skipped unless we touch interior lines.

### 6.3 Benchmarks (rate=1200/tick=30)

| Scenario | TTFMC | Completion | Queue depth (avg/p95/max) | Notes |
| --- | --- | --- | --- | --- |
| V2 (MDX enabled) | **0.54 s** | **56.1 s** | **1.56 / 2.00 / 2.00** | Soft-drain prototype keeps queue depth capped; patch→DOM p95 2.8 ms |
| V2 (MDX disabled) | **0.25 s** | **54.1 s** | **1.55 / 2.00 / 2.00** | Slightly faster now that low-priority drains trigger after ~12 ms |
| Streamdown reference | **0.35 s** | **34.9 s** | n/a | Legacy renderer remains faster, still our target |

Queue-delay samples for nested lists now peak at ~32 ms (previously ~40 ms) with only four flushes exceeding 20 ms out of 233 measured in `headers_with_lists.md`. The rest hover around 6–7 ms thanks to the soft-drain follow-up; detailed logs live under `tmp/snippet_analysis/performance-metrics.json → *.flushBatches`.

### 6.4 Guardrails

- `scripts/benchmark-renderers.ts` fails the run when V2 queue depth p95 exceeds **2.05** or completion time crosses **60 s**. This is meant for CI once the dev server can be bootstrapped headlessly.
- `window.__STREAMING_DEMO__` exposes `setMdxEnabled(enabled)` (legacy) and `setMdxStrategy(mode)` (`server` / `worker`) so benchmarks and manual QA can flip compilation modes without patching code. **External consumers should rely on the `StreamingMarkdownHandle` ref instead; the global shim stays only for demo tooling.**

### 6.5 Next Steps

1. Stress-test the new paragraph clamp in the worker and ensure deferred queues drain smoothly on long-form prose.
2. Validate virtualization toggles on deeply nested fixtures and capture before/after DOM cadence.
3. Explore opportunistic flushes when the main thread is idle to cut the end-to-end completion time gap vs. Streamdown.
- When debugging or capturing snapshots, remember that `window.__STREAMING_DEMO__` exposes `setMdxStrategy(mode)`, `setMdxEnabled(enabled)`, `flushPending()`, and `waitForIdle()` helpers as described above; the shim forwards into the instance ref and will eventually be removed once automation harnesses migrate.

### 6.6 Inline HTML Rendering

- Paragraph/blockquote/list views no longer special-case `<kbd>`; all inline HTML flows through a registry-driven renderer (`lib/markdown-v2/utils/inline-html.ts`). Inline-only tags (`kbd`, `sub`, `sup`, etc.) render as real DOM nodes with sanitized attributes, while block-level fragments (KaTeX wrappers, embedded divs) split the paragraph and render as siblings. This is what fixes the hydration warning where KaTeX `<div>`s were nested inside `<p>`.
- Added `lib/markdown-v2/tests/inline-html-rendering.test.ts` to lock the behaviour: it asserts `<kbd>\`Ctrl\`</kbd>` renders as `<kbd><code>…</code></kbd>` and verifies block-level math HTML becomes standalone siblings.
- Sanitizer schema already whitelists `kbd/sub/sup`; no schema changes were needed. Consumers can extend the inline renderer map to support additional safe tags without editing core code.
- Telemetry is exposed via `window.__STREAMING_DEMO__` in the demo page (`/examples/streaming`); use it to inspect queue depth, patch latency, and worker timing.
- The automation API now exposes `flushPending()`/`waitForIdle()` helpers and the snippet harness calls them after `finalize()` so short snippets can complete deterministically.

### 6.7 Snippet Analyzer Baseline (2025-11-04)

- `pnpm exec tsx scripts/analyze-test-snippets.ts` renders all 16 fixtures (Markdown + MDX) without hard failures. Use `MDX_COMPILE_MODE=worker` to exercise inline compilation. Latest outputs live under `tmp/snippet_analysis/`.
- `npm run markdown-v2:test:snippets` (new) is a shorthand for the analyzer; ensure the dev server is listening on port 3006 first.
- Server compile: TTFMC **0.52 s → 0.99 s**, completion **0.29 s → 5.2 s**, queue depth ≤2. Worker compile shows comparable numbers (TTFMC within ±15 ms, completion within ±80 ms on the current dev machine).
- Existing warnings (KaTeX DOM heuristics, Shiki class mismatches, long TTFMC on `headers_with_lists.md`) are unchanged and tracked separately; treat them as informational until expectations are tightened.
- Analyzer now flags pending/error MDX blocks (critical when `MDX_COMPILE_MODE=worker`) so unfinished inline compilation trips CI instead of slipping through.
- Analyzer persists `coalescingTotals` and surfaces reduction % / merged op counts in `analysis-summary.md` so regressions in batching efficiency show up alongside queue depth and patch latency.

## 6. Performance Snapshot

Results from the latest benchmark (03/??/2024, Naive Bayes article fixture):

| Metric | V2 Observed |
| --- | --- |
| TTFMC | ~0.26 s |
| Time to completion | ~16.5 s |
| Patch→DOM p95 | 1.1 ms |
| Patch→DOM max | 3.6 ms |
| Queue depth avg / p95 / max | 1.31 / 2.00 / 2.00 |

_Benchmark parameters: streaming rate 1.8 kchars/s, tick 30 ms._

**Interpretation:**

- Raising the streaming rate to 1.8 kchars/s and buffering scheduler commits drops completion to ~16 s while keeping queue depth at or below 2.
- Patch processing stays sub‑1.5 ms at p95 despite the larger batches, indicating the accumulator doesn’t burden React.
- Remaining latency is dominated by MDX/code enrichment bursts (paint p95 ~120 ms); further gains will come from incremental hydration rather than scheduler tweaks.

### 6.1 Linear Coalescing Benchmark

We now ship a dedicated micro-benchmark to compare the legacy quadratic coalescer with the new accumulator:

```bash
pnpm run markdown-v2:bench:coalescing
```

Latest local run (Node 22.19.0, November 06) produced:

| Patch burst | Iterations | Quadratic (ms) | Linear (ms) | Speedup | Output reduction |
| --- | --- | --- | --- | --- | --- |
| 50 patches | 200 | 7.11 | 5.65 | 1.26× | 50 % |
| 100 patches | 200 | 5.23 | 2.90 | 1.81× | 25 % |
| 200 patches | 200 | 5.50 | 2.05 | 2.68× | 12.5 % |
| 500 patches | 50 | 3.28 | 1.30 | 2.52× | 5 % |
| 1000 patches | 50 | 6.15 | 1.99 | 3.09× | 2.5 % |

The reduction column shows how many ops are eliminated by the coalescer before hitting the store. Heavier wins occur in code-fence streaming scenarios; setProps-heavy runs still benefit from batching even when the patch count stays similar.

Telemetry emitted by the scheduler/demo now includes `coalescingTotals { input, output, coalesced, appendLines, setProps, insertChild, durationMs }`. Use `window.__STREAMING_DEMO__.getCoalescingTotals()` or scrape `getPerf().coalescingTotals` to watch reduction percentages during manual testing.

- The streaming demo’s control panel now has a **Coalescing telemetry** card that visualises totals plus the last six flushes. Reset the card when you want a fresh delta without restarting the stream.
- For CI comparisons, run `pnpm run markdown-v2:diff:coalescing -- --before baseline.json --after current.json` to print before/after tables and percentage deltas.

## 7. Known Issues & Next Steps

1. **End-to-end latency:** Completion time still trails the streamdown baseline by ~17 s; continue experimenting with idle flushes and batching heuristics now that queue spikes are gone.
2. **Benchmark anomalies:** The streamdown scenario occasionally reports zero mutations in headless runs; ensure the fixture loads reliably before comparing completion times.
3. **MDX error surfacing:** The worker logs MDX compile errors but the UI still renders a generic error span. Add a proper renderer component with context.
4. **Analyzer warnings:** KaTeX DOM and Shiki class mismatches still appear as warnings. Once expectations are encoded, upgrade them to failures.
5. **Snippet harness robustness:** `scripts/analyze-test-snippets.ts` now exposes tuning knobs (`SNIPPET_STREAM_TIMEOUT_MS`, `SNIPPET_OUTPUT_TIMEOUT_MS`, `SNIPPET_SKIP`) but still times out on some streams when the automation API never reinitialises. Capture logs (`DEBUG_SNIPPET_BLOCKS=1`) and plan a dedicated fix before wiring the suite into CI.

## 8. Working Checklist

- **Rebuild the worker** after changing any file under `lib/markdown-v2/worker*`: `npm run worker:build`.
- **Run the targeted tests** touched by your change set (see §5.1); use `npm run markdown-v2:test` for a full sweep.
- **Capture telemetry** with `scripts/analyze-test-snippets.ts` and `scripts/benchmark-renderers.ts` before and after major tuning.
- **Update this handbook** alongside significant architecture or tuning changes so new engineers do not rely on stale knowledge.

## 9. Latest updates (Nov 2025)

- **Public `<StreamingMarkdown>` component.**  
  The demo now mounts the new React wrapper which owns its own worker/render store while exposing a ref-based control surface (`append`, `pause`, `resume`, `restart`, `finalize`, `setCredits`, `flushPending`, `waitForIdle`, `getState`). The legacy instrumentation pipeline still runs in parallel so telemetry/automation stay compatible while we migrate tests.
- **Package entry points.**  
  Imports are routed through `@stream-mdx/{core,react,worker,plugins}`; built-ins (footnotes, tables, html, mdx, callouts, math) are gated by `StreamingMarkdown.features`/worker `docPlugins`. Set `features.math = false` to disable remark-math/KaTeX entirely.
  - `@stream-mdx/plugins`: callouts/tables/html/mdx/math registries and helpers (see `docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`). Build the distributable bundle with `npm run markdown-v2:build:plugins` to verify tree-shaking per plugin.  
  Tree-shaking works locally; the next step is wiring these workspaces into the release pipeline.

---

**Maintainers:** Streaming Markdown V2 Team  
**Support:** `#streaming-markdown-v2` Slack channel / Linear project `STREAM-MDX`
