# Public API — Streaming Markdown V2

_Last updated: 2025-11-14_

The refactor splits the renderer into packages you can consume independently:

| Package | Description |
| --- | --- |
| `@stream-mdx/core` | Patch/metrics types, AST helpers, sanitization primitives. No React, no DOM. |
| `@stream-mdx/worker` | Worker entry point + message unions. Parses markdown/MDX, runs Shiki, emits `PATCH` batches + metrics. |
| `@stream-mdx/react` | React bindings (`<StreamingMarkdown />`), renderer store, patch scheduler, node views, virtualization. |
| `@stream-mdx/plugins/*` | Optional plugins (math, mdx, tables, html, callouts). Each exports both worker + React hooks. |

Everything below assumes you import from those packages rather than the demo app.

---

## 1. React Component

```tsx
import { StreamingMarkdown, type StreamingMarkdownHandle } from "@stream-mdx/react";
import { mathPlugin } from "@stream-mdx/plugins/math";
import { mdxPlugin } from "@stream-mdx/plugins/mdx";

const handle = useRef<StreamingMarkdownHandle>(null);

<StreamingMarkdown
  ref={handle}
  text="## Hello\n\nStreaming **markdown**"
  plugins={[mathPlugin(), mdxPlugin({ components: customComponents })]}
  prewarmLangs={["python", "bash"]}
  worker={customWorker}          // optional (see §2)
  features={{ tables: true, callouts: true }}
  scheduling={{ batch: "rAF", maxOpsPerFrame: 300 }}
  components={{ heading: HeadingView, code: CodeFence }}
  onMetrics={(m) => console.table(m.queueDelay)}
  onError={(err) => reportError(err)}
/>;
```

### Props

| Prop | Type | Notes |
| --- | --- | --- |
| `text` | `string` | Static markdown. Mutating it restarts the session. |
| `stream` | `AsyncIterable<string>` | Alternative to `text`. Append-only stream; exactly one of `text` or `stream`. |
| `worker` | `Worker \| URL \| () => Worker` | Provide your own worker instance/URL/factory. Defaults to Blob-backed worker bundle. |
| `prewarmLangs` | `string[]` | Shiki languages to load up front inside the worker. |
| `plugins` | `MarkdownV2Plugin[]` | Functions from `@stream-mdx/plugins/*`. |
| `features` | `{ footnotes?, html?, mdx?, tables?, callouts?, math? }` | Toggle built-in feature flags without importing plugins. `math` gates remark-math/KateX. |
| `components` | `Partial<BlockComponents>` | Override block renders. |
| `inlineComponents` | `Partial<InlineComponents>` | Override inline renders. |
| `scheduling` | `{ batch?, maxOpsPerFrame?, lowPriorityFrameBudgetMs?, historyLimit? }` | Patch scheduler knobs (defaults match the demo). |
| `onMetrics` | `(metrics: RendererMetrics) => void` | Invoked for every flush. Includes queue depth, durations, adaptive state. |
| `onError` | `(error: Error) => void` | Render-time errors (worker errors bubble through `error` events separately). |
| `className`, `style` | React props forwarded to the root container. |

### Imperative Handle

```ts
type StreamingMarkdownHandle = {
  pause(): void;
  resume(): void;
  restart(): void;
  finalize(): void;
  waitForIdle(): Promise<void>;
  flushPending(): PatchFlushResult | null;
  getState(): {
    blocks: ReadonlyArray<Block>;
    queueDepth: number;
    pendingBatches: number;
    isPaused: boolean;
    rendererVersion: number;
    store: RendererStore;
    lastMetrics: RendererMetrics | null;
  };
  getPatchHistory(limit?: number): ReadonlyArray<PatchFlushResult>;
};
```

The demo’s `window.__STREAMING_DEMO__` shim forwards to this handle so automation/tests keep working, but package consumers should rely on the ref directly.

---

## 2. Worker Options

The `worker` prop accepts:

1. **Default / Blob** – omit the prop and the component instantiates a Blob URL pointing to the bundled worker (`@stream-mdx/worker`). CSP must allow `blob:` execution.
2. **URL** – pass `new URL("./markdown-worker.js", import.meta.url)` when you host the worker file yourself (stricter CSP / CDN deployment).
3. **Factory or Instance** – pass a `() => new Worker(url, { type: "module" })` factory or an already-created `Worker`. Useful for SSR, custom pools, or tests.

```tsx
const workerUrl = new URL("../public/workers/markdown-worker.js", import.meta.url);

<StreamingMarkdown
  worker={() => new Worker(workerUrl, { type: "module", name: "markdown-v2" })}
/>;
```

**Security/CSP tips**

- Hosted/factory workers avoid `blob:` requirements; use them when your CSP is restrictive.
- Serve worker bundles from the same origin with `Cross-Origin-Embedder-Policy: require-corp` / `Cross-Origin-Opener-Policy: same-origin` if you need SharedArrayBuffers.
- Raw HTML is sanitized by default (see `@stream-mdx/core/security`); extend the schema only for trusted content.

> Helper reminder: `createDefaultWorker({ url?, mode? })` from `@stream-mdx/worker` encapsulates the logic above and respects `<script data-markdown-v2-worker-url>` / `<meta name="markdown-v2:worker">` overrides. Pass the helper’s factory to the `worker` prop or rely on the component’s default instantiation.

---

## 3. Plugins

Each plugin exports a descriptor with worker + React hooks. Example: math + MDX.

```ts
import { mathPlugin } from "@stream-mdx/plugins/math";
import { mdxPlugin } from "@stream-mdx/plugins/mdx";

const plugins = [
  mathPlugin({ katexOptions: { macros: { "\\RR": "\\mathbb{R}" } } }),
  mdxPlugin({ components: { YouTube, Callout } }),
];

<StreamingMarkdown text={text} plugins={plugins} />;
```

Plugins can inspect the feature flags you pass via `features` if they need to coordinate with the worker.

> **Automation API:** The demo still exposes `window.__STREAMING_DEMO__` for Playwright/StageRunner. Consumers should rely on the `StreamingMarkdownHandle` ref; the global shim will be removed once downstream automation migrates. The shim attaches automatically only in development builds—set `NEXT_PUBLIC_STREAMING_DEMO_API=true` if you must enable it elsewhere.

> **Reference:** Follow the [Math + MDX worker/renderer recipe](STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md#5-math--mdx-workerrenderer-registration) to keep `features`/`docPlugins` in sync; CI now enforces this path via dedicated tests.

---

## 4. Metrics

`onMetrics` receives a summarized version of every patch flush:

```ts
type RendererMetrics = {
  tx?: number | null;
  receivedAt: number;
  committedAt: number;
  durationMs: number;         // flush duration (React + DOM)
  patchToDomMs: number;       // committedAt - receivedAt
  totalPatches: number;
  appliedPatches: number;
  queueDepthBefore: number;
  remainingQueueSize: number;
  batchCount: number;
  queueDelay: { avg: number; p95: number; max: number };
  priorities: Array<"high" | "low">;
  adaptiveBudget?: AdaptiveBudgetState; // adaptive throttling state
  flush: PatchFlushResult;    // includes per-batch coalescing metrics + adaptive flags
};
```

`AdaptiveBudgetState` captures whether adaptive throttling is active, the current batch caps, and the p95 thresholds (6 ms to activate, 4 ms to deactivate). Both types are exported from `@stream-mdx/react`.

```ts
import type { RendererMetrics } from "@stream-mdx/react";

function onMetrics(metric: RendererMetrics) {
  if (metric.adaptiveBudget?.active) {
    console.info("Adaptive mode engaged", metric.adaptiveBudget);
  }
}
```

The starter (`examples/streaming-markdown-starter/components/StreamingDemo.tsx`) stores the last metrics payload and renders `queueDelay` + `adaptiveBudget` so you can copy the wiring into dashboards.

Use this hook to feed dashboards, regressions, or adaptive back-pressure in your host app. The demo also exposes `api.getPerf()` for automation scripts; consumers should stick to `onMetrics`.

---

## 5. Streaming Data Sources

You can stream text via an `AsyncIterable<string>` instead of `text`:

```ts
async function* chunksFromReadable(readable: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await readable.read();
    if (done) break;
    yield decoder.decode(value, { stream: true });
  }
}

<StreamingMarkdown stream={chunksFromReadable(response.body!.getReader())} />;
```

The worker maintains a single “dirty tail” block; finalized blocks never change, so React renders remain stable.

---

## 6. Scheduling & Virtualization

Scheduling defaults (matching the demo):

```ts
{
  batch: "rAF",
  frameBudgetMs: 9,
  lowPriorityFrameBudgetMs: 4,
  maxBatchesPerFlush: 5,
  maxLowPriorityBatchesPerFlush: 3,
  urgentQueueThreshold: 3,
  historyLimit: 200,
}
```

Override via the `scheduling` prop. The scheduler automatically toggles into “adaptive” mode when coalescing itself becomes expensive (p95 > 6 ms); in that state it halves batch counts until p95 < 4 ms again.

Virtualization is automatic for code blocks once they exceed the configured line threshold (default 200). Override via `components.code` or by passing a `virtualizedCode` config through the `components` override if you need bespoke behavior.

---

## 7. Automation & Testing Helpers

- `StreamingMarkdownHandle` + the automation shim expose `flushPending()`, `waitForIdle()`, `getPatchHistory()`, etc. Use those in Playwright/StageRunner tests.
- `scripts/analyze-test-snippets.ts` and `scripts/benchmark-renderers.ts` consume the public API exclusively as part of the refactor; treat them as reference tooling.

---

Questions? Ping the `STREAMING_MARKDOWN_V2_STATUS.md` handbook for the latest knobs, or file follow-ups in the “Refactor Phase 5” milestone. This doc should evolve whenever the exported API changes.*** End Patch***
