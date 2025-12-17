# Public API — StreamMDX

_Last updated: 2025-12-17_

## Packages & Entry Points

StreamMDX is published as both scoped packages and an unscoped convenience wrapper:

| Package | Use when… |
| --- | --- |
| `stream-mdx` | You want a single dependency and stable import paths (recommended for apps). |
| `@stream-mdx/react` | You want the React surface without the wrapper. |
| `@stream-mdx/worker` | You want the worker client + hosted worker bundle (browser + Node). |
| `@stream-mdx/core` | You want types + perf/sanitization helpers (no React). |
| `@stream-mdx/plugins/*` | You are building/customizing a worker bundle or need plugin primitives. |

When you install `stream-mdx`, you can also import:

- `stream-mdx/react`, `stream-mdx/worker`, `stream-mdx/core`
- `stream-mdx/worker/node` (Node `worker_threads` helper)
- `stream-mdx/plugins/*` (common plugin entrypoints; useful for pnpm users)

---

## 1) `<StreamingMarkdown />`

```tsx
"use client";

import { StreamingMarkdown, type StreamingMarkdownHandle } from "stream-mdx";

const ref = useRef<StreamingMarkdownHandle>(null);

<StreamingMarkdown
  ref={ref}
  text="## Hello\n\nStreaming **markdown**"
  worker="/workers/markdown-worker.js"
  features={{ tables: true, html: true, math: true, mdx: true }}
  mdxCompileMode="worker"
  prewarmLangs={["python", "bash"]}
  onMetrics={(m) => console.table(m.queueDelay)}
  onError={(err) => reportError(err)}
/>;
```

### Props

| Prop | Type | Notes |
| --- | --- | --- |
| `text` | `string` | Static markdown. Mutating it restarts the session. |
| `stream` | `AsyncIterable<string>` | Append-only stream; provide **either** `text` or `stream`. |
| `worker` | `Worker \| URL \| string \| () => Worker` | Worker instance/URL/factory. When omitted, the component uses the default worker strategy and falls back to `/workers/markdown-worker.js`. |
| `managedWorker` | `boolean` | When `true`, the component attaches the worker but does not auto-`restart/append/finalize` for you (use the ref handle). |
| `prewarmLangs` | `string[]` | Shiki languages to load inside the worker. |
| `features` | `{ footnotes?, html?, mdx?, tables?, callouts?, math? }` | Toggles built-in feature flags. |
| `mdxCompileMode` | `"server" \| "worker"` | Enables MDX compilation/hydration and selects the compile strategy. |
| `components` | `Partial<BlockComponents>` | Override block renders (wrap code/math without affecting the patch scheduler). |
| `inlineComponents` | `Partial<InlineComponents>` | Override inline renders. |
| `tableElements` | `Partial<TableElements>` | Override table tags (e.g. Shadcn table wrappers). |
| `htmlElements` | `Partial<HtmlElements>` | Override HTML tag renders (when HTML is enabled). |
| `mdxComponents` | `Record<string, ComponentType>` | Component registry used when hydrating MDX. |
| `scheduling` | `StreamingSchedulerOptions` | Patch scheduler/backpressure knobs. |
| `onMetrics` | `(metrics: RendererMetrics) => void` | Invoked after each flush (queue depth, timings, adaptive budget state, worker metrics). |
| `onError` | `(error: Error) => void` | Render-time errors. (Worker runtime errors surface via `error` events on the Worker.) |
| `className`, `style` | React props forwarded to the root container. |

### Imperative Handle

```ts
type StreamingMarkdownHandle = {
  pause(): void;
  resume(): void;
  restart(): void;
  finalize(): void;
  append(text: string): void;
  setCredits(value: number): void;
  flushPending(): PatchFlushResult | null;
  waitForIdle(): Promise<void>;
  onFlush(listener: (result: PatchFlushResult) => void): () => void;
  getState(): RendererStateSnapshot;
  getPatchHistory(limit?: number): ReadonlyArray<RendererMetrics>;
};
```

---

## 2) Worker Hosting + CSP

Recommended production setup is to host the worker bundle from static assets and point the component at it:

```bash
mkdir -p public/workers
cp node_modules/@stream-mdx/worker/dist/hosted/markdown-worker.js public/workers/markdown-worker.js
```

```tsx
<StreamingMarkdown worker="/workers/markdown-worker.js" />
```

Worker ownership semantics:

- `worker="/.../markdown-worker.js"` or `worker={new URL(...)}`
  - StreamMDX creates + terminates the Worker instance for you.
- `worker={existingWorker}` or `worker={() => existingWorker}`
  - StreamMDX treats the Worker as externally managed and will not terminate it.
- `worker={undefined}`
  - StreamMDX uses the default worker strategy and falls back to `/workers/markdown-worker.js`.

For advanced worker instantiation (CSP overrides, shared worker instances), see `createDefaultWorker()` in `stream-mdx/worker`.

### Node / CLI runtimes

To run the hosted worker bundle in Node (via `worker_threads`), use:

- `@stream-mdx/worker/node` (scoped)
- `stream-mdx/worker/node` (convenience wrapper)

See `docs/CLI_USAGE.md` for an example that consumes `PATCH` messages into a `DocumentSnapshot`.

---

## 3) Features

`features` toggles built-in capabilities in the worker + renderer:

- `tables`: GitHub-flavored markdown tables → table block snapshots (`tableElements` controls rendering).
- `html`: enables inline/raw HTML (sanitized by default; `htmlElements` controls rendering).
- `mdx`: recognizes MDX blocks (requires `mdxCompileMode` to compile/hydrate).
- `math`: recognizes inline + display math (default delimiters: `$…$` and `$$…$$`).
- `footnotes`: enables footnote aggregation.
- `callouts`: enables callout blockquote syntax (disabled by default in the worker).

---

## 4) MDX Compilation Modes

`mdxCompileMode` selects how MDX blocks are compiled:

- `"worker"`: compilation happens client-side in the worker.
- `"server"`: compilation requests go to `/api/mdx-compile-v2` by default (you must implement this endpoint in your app).

See `docs/REACT_INTEGRATION_GUIDE.md` for a complete Next.js wiring guide and parity notes.

---

## 5) Metrics & Scheduling

### `onMetrics`

`onMetrics` receives `RendererMetrics` after each flush. The payload includes queue depth, queue delay distribution, worker patch metrics, and the adaptive throttling state.

Adaptive throttling is based on coalescing p95 thresholds:

- activates when coalescing p95 > **6ms**
- deactivates when coalescing p95 < **4ms**

### `scheduling`

`scheduling` (a subset of the patch scheduler options) includes:

- `frameBudgetMs` (default: 8)
- `lowPriorityFrameBudgetMs` (default: half the frame budget, min 2)
- `maxBatchesPerFlush` (default: unlimited; governed by frame budget)
- `maxLowPriorityBatchesPerFlush` (default: 1)
- `urgentQueueThreshold` (default: 3)
- `batch` (`"rAF" | "timeout" | "microtask"`, default: `"rAF"` when available)
- `historyLimit` (default: 200)

---

## 6) Streaming Sources

You can stream text via an `AsyncIterable<string>`:

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

---

## 7) Plugins & Extensibility

Most consumers should start with `features` rather than wiring plugin registries directly.

If you need deeper control (custom tokenizers, custom streaming matchers, custom worker bundles), see:

- `docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`
- `stream-mdx/plugins/*` (convenience package)
- `@stream-mdx/plugins/*` (scoped packages)
