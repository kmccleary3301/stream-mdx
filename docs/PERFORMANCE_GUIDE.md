# StreamMDX Performance Guide

This guide summarizes the main performance levers in the Streaming Markdown V2 pipeline and how to measure them.

---

## 1) Core Metrics

### Patch throughput
Captured in `patchStats` (automation API + capture summaries):

- `totalOps`, `totalMessages`
- `opsPerKB`, `messagesPerKB` (normalized)
- per-op counts for current patch operations (appendCode, decorateCode, setProps, insertChild, etc.)

### Paint cadence
From the demo automation API and capture summary:

- `paint avg`, `p95`, `max` (ms)
- goal: keep **p95 < ~16ms** on target hardware

### Long tasks
Long-task observer metrics:

- `longTask avg`, `p95`, `max` (ms)
- use to detect main‑thread stalls during streaming

### Worker handshake
Worker boot/parse/highlighter timings and fingerprints:

- `bootMs`, `parseMs`, `highlighterMs`
- dev fingerprints in worker bundle are captured by `dump-browser-html.ts`

### Diagnostic work counters

Use `scripts/perf/build-diagnostic-bundle.ts` for private campaign work counters, not the normal package build. Normal builds fold out counter reads, sink calls, diagnostic options and extra forwarded counter arguments. Inert private parameter names may remain in emitted JavaScript; a string-marker match alone does not prove executed bookkeeping.

Work counts describe inspected source, records and prepared rows, not elapsed CPU time. Keep their source/artifact identities separate from production timing evidence.

---

## 2) Scheduling Controls (client)

`StreamingMarkdown` accepts `scheduling` options (see `packages/markdown-v2-react/src/streaming-markdown.tsx`):

```ts
scheduling?: {
  batch?: "rAF" | "microtask" | "timeout";
  frameBudgetMs?: number;
  maxBatchesPerFlush?: number;
  lowPriorityFrameBudgetMs?: number;
  maxLowPriorityBatchesPerFlush?: number;
  urgentQueueThreshold?: number;
  adaptiveSwitch?: boolean;
  adaptiveQueueThreshold?: number;
}
```

**Recommendations**

- Use `batch: "rAF"` when paint smoothness matters more than throughput.
- Use `batch: "microtask"` when throughput matters more than paint.
- Start with `frameBudgetMs ~ 8–12` and tune based on paint p95.
- For claim-grade comparisons, prefer the benchmark lab's locked `rAF` profile instead of ad hoc scheduler tuning.

### Jitter discipline

Keep the interpretation strict:

- scheduler changes may move latency and throughput numbers
- they must not change final correctness
- if seeded runs diverge under scheduler variation, treat that as a correctness problem, not a perf footnote

See [`SCHEDULING_AND_JITTER.md`](./SCHEDULING_AND_JITTER.md) for the current benchmark-mode contract.

---

## 3) Code Highlighting Modes

Control via `features.codeHighlighting`:

- `"incremental"` – progressive line‑level highlight, best for long streams
- `"final"` – only highlight after block finalizes
- `"live"` – re‑highlight on every patch (high CPU cost)

Use `liveCodeHighlighting` sparingly; it can spike CPU on large blocks.

---

## 4) Code Virtualization

Large code blocks are windowed to limit mounted DOM rows. Geometry and native row preparation are separate owners:

- `useVirtualizedCode` in `packages/markdown-v2-react/src/renderer/virtualized-code.tsx` owns viewport geometry and scroll behavior only.
- `CodeLineRangeView` in `packages/markdown-v2-react/src/renderer/code-line-range.tsx` subscribes to fixed 64-row store ranges and prepares native rows. Completed range snapshots remain stable across tail appends.
- Below the virtualization threshold, or when virtualization is explicitly disabled, the geometry range covers the full code block; native rendering still includes every row.
- Config: `DEFAULT_VIRTUALIZED_CODE_CONFIG` in `packages/markdown-v2-react/src/renderer/virtualized-code.tsx`
- Metrics emitted in capture summaries:
  - `virtualized`, `totalLines`, `mountedLines`, `windowSize`

This owner split does not change the virtualization threshold or establish an efficiency claim. Compare actual mapped-row counters on the original campaign before making such a claim.

The outer code frame is a `div`; native prepared rows render inside one semantic `pre`/`code` pair. Copy and download materialize the complete code body only when invoked. They use the same LF and closing-separator normalization as cold code metadata, while authored source exports retain original line endings. A language engine or legacy controls component that explicitly requests a full code string still pays that cold-read cost.

---

## 5) Coalescing & Patch Reduction

Patch coalescing reduces redundant patch applications (especially lists/tables).

- Metrics available in capture summary: input/output counts, coalesced count, operation counts, reduction percentage, and coalescing duration.
- Start the docs app with `npm run docs:dev`, then run `npm run test:snippets` (default URL `http://localhost:3000/regression/snippet-test`; override with `SNIPPET_TEST_URL`). The analyzer reports each real-snippet reduction in `tmp/snippet_analysis/performance-metrics.json` and `analysis-report.json`; no per-snippet percentage is a pass/fail threshold.
- The analyzer requires complete totals: all five patch-count fields must be finite non-negative integers, duration must be finite and non-negative, `input = output + coalesced`, and the combined setProps/insertChild counts cannot exceed `input`. Missing, invalid, or inconsistent totals fail analysis.
- The separate controlled React regression retains the 10% minimum for 60 deliberately redundant title updates and asserts the final consumer title is exactly `value-59`. Full consumer replay checks raw, linear, and quadratic results independently of real-snippet telemetry.

The existing default coalescing-duration p95 guard remains 8 ms: a higher p95 fails. It uses all eligible samples in the demo's retained flush-batch window (300 in production, 1,000 otherwise), not all-ever batches or a minimum sample quota. The scheduler intentionally skips coalescing for singleton patch batches; every retained multi-patch batch must include a finite, non-negative coalescing duration. Missing or invalid duration data fails the guard. With no duration samples, true no-work telemetry warns as not applicable; otherwise the guard fails. Unsuppressed warnings also make the analyzer exit non-zero.
---

## 6) Worker Prewarm

Prewarm languages to reduce first‑highlight latency:

```tsx
<StreamingMarkdown prewarmLangs={["ts", "json", "bash"]} />
```

Use for docs sites where you know the language set ahead of time.

---

## 7) Capture & Baselines

Use the capture tooling to establish production baselines:

```bash
npx tsx scripts/run-markdown-v2-capture.ts \
  --lengths 3000,8000,12000 \
  --production true \
  --verify-replay true \
  --screenshot true
```

Capture summary JSON includes normalized metrics and is used by CI gates.

---

## 8) Common Bottlenecks

- **Long‑task spikes** → reduce live highlighting, lower patch batch size, enable virtualization.
- **High opsPerKB** → review patch coalescing, list/table splitting, and chunk sizes.
- **Slow paint p95** → prefer rAF batching, reduce worker flush rate, defer heavy blocks.

---

## 9) Related Docs

- `docs/PERF_HARNESS.md`
- `docs/SCHEDULING_AND_JITTER.md`
- `docs/STREAMING_CAPTURE_SOP.md`
- `docs/STREAMING_CAPTURE_TOOL.md`
- `docs/REGRESSION_TESTING.md`

Perf gate note:
- `npm run perf:gate` supports an optional edge-like stress comparison via `--candidateEdge` / `--baseEdge` (alias `--candidateS6` / `--baseS6`).
