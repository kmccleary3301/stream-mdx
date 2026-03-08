# StreamMDX Performance Guide

This guide summarizes the main performance levers in the Streaming Markdown V2 pipeline and how to measure them.

---

## 1) Core Metrics

### Patch throughput
Captured in `patchStats` (automation API + capture summaries):

- `totalOps`, `totalMessages`
- `opsPerKB`, `messagesPerKB` (normalized)
- per‑op counts (appendLines, setProps, insertChild, etc.)

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

---

## 3) Code Highlighting Modes

Control via `features.codeHighlighting`:

- `"incremental"` – progressive line‑level highlight, best for long streams
- `"final"` – only highlight after block finalizes
- `"live"` – re‑highlight on every patch (high CPU cost)

Use `liveCodeHighlighting` sparingly; it can spike CPU on large blocks.

---

## 4) Code Virtualization

Large code blocks are windowed to reduce DOM cost.

- Config: `DEFAULT_VIRTUALIZED_CODE_CONFIG` in `packages/markdown-v2-react/src/renderer/virtualized-code.tsx`
- Metrics emitted in capture summaries:
  - `virtualized`, `totalLines`, `mountedLines`, `windowSize`

**Guidance**

- For documents with 500+ line blocks, keep virtualization enabled.
- If you must disable it, set `STREAM_MDX_DISABLE_VIRTUALIZED_CODE=true`.

---

## 5) Coalescing & Patch Reduction

Patch coalescing reduces redundant patch applications (especially lists/tables).

- Metrics available in capture summary:
  - input/output counts
  - coalesced count
  - p95 coalescing duration

If coalescing duration spikes, increase frame budget or reduce streaming rate.

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
- `docs/STREAMING_CAPTURE_SOP.md`
- `docs/STREAMING_CAPTURE_TOOL.md`
- `docs/REGRESSION_TESTING.md`

Perf gate note:
- `npm run perf:gate` supports an optional edge-like stress comparison via `--candidateEdge` / `--baseEdge` (alias `--candidateS6` / `--baseS6`).
