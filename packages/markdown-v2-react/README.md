# `@stream-mdx/react`

React bindings for the Streaming Markdown V2 renderer. Exports the `<StreamingMarkdown />` component, the renderer store, patch scheduler, hooks, and default node/inline views. Pair it with `@stream-mdx/core`, `@stream-mdx/worker`, and optional `@stream-mdx/plugins/*`.

> _Status: pre-release (`0.9.x`). API documentation lives in `docs/PUBLIC_API.md`. Treat the README as the entry point for downstream consumers once the refactor stabilizes._

## Install

```bash
npm install @stream-mdx/react @stream-mdx/core
# optional: npm install @stream-mdx/plugins/math @stream-mdx/plugins/mdx ...
```

Ensure you also bundle/host the worker from `@stream-mdx/worker`; see **Worker options** below.

## Quick start

```tsx
import { useRef } from "react";
import { StreamingMarkdown, type StreamingMarkdownHandle } from "@stream-mdx/react";
import { mathPlugin } from "@stream-mdx/plugins/math";
import { mdxPlugin } from "@stream-mdx/plugins/mdx";

export function Article({ source }: { source: string }) {
  const handle = useRef<StreamingMarkdownHandle>(null);

  return (
    <StreamingMarkdown
      ref={handle}
      text={source}
      plugins={[mathPlugin(), mdxPlugin({ components: customComponents })]}
      prewarmLangs={["python", "ts"]}
      features={{ tables: true, callouts: true }}
      scheduling={{ batch: "rAF", maxOpsPerFrame: 300 }}
      onMetrics={(metrics) => console.debug("[flush]", metrics.queueDelay)}
    />
  );
}
```

> Need a refresher on how math + MDX features stay aligned between the renderer and worker? See [`docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md#5-math--mdx-workerrenderer-registration`](../../docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md#5-math--mdx-workerrenderer-registration) for the canonical checklist (now guarded by unit tests).

### Worker options

| Prop usage | Description |
| --- | --- |
| _Omit `worker`_ | Default Blob-backed worker (requires `blob:` CSP allowance). |
| `worker="/workers/markdown-worker.js"` | Hosted URL (serve the built worker bundle yourself). |
| `worker={() => new Worker(new URL("./markdown-worker.js", import.meta.url), { type: "module" })}` | Custom factory/instance (SSR pools, tests, strict CSP). |

Build the worker via `npm run worker:build` to produce `public/workers/markdown-worker.js` before wiring it into downstream apps.

### Props & handle

See `docs/PUBLIC_API.md` for the full prop table. Highlights:

- `text` or `stream` (AsyncIterable) provide markdown chunks.
- `plugins` accepts descriptors from `@stream-mdx/plugins/*`.
- `features` toggles built-in parsers (math/mdx/tables/html/callouts).
- `components` / `inlineComponents` override block/inline renders.
- `scheduling` tunes the rAF patch scheduler (+ adaptive coalescing).
- `onMetrics` receives `RendererMetrics` (queue depth, coalescing stats, adaptive budget state).
- The ref exposes imperative helpers (`pause`, `resume`, `restart`, `finalize`, `waitForIdle`, `getPatchHistory`, `flushPending`).

### Streaming from async sources

```tsx
async function* streamChunks(text: string) {
  for (const token of text.split(" ")) {
    yield `${token} `;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

<StreamingMarkdown stream={streamChunks(longArticle)} worker="/workers/markdown-worker.js" />;
```

## Metrics hook

Attach `onMetrics` to feed dashboards:

```ts
const handleFlush = (metrics: RendererMetrics) => {
  if (metrics.adaptiveBudgetActive) {
    alert("Coalescing over budget, throttling batches!");
  }
  sendToDatadog({
    queueDepthP95: metrics.queueDelay.p95,
    coalescingReduction: metrics.flush.batches.at(-1)?.coalescing?.coalescedCount,
  });
};

<StreamingMarkdown onMetrics={handleFlush} />;
```

## Overriding components

```tsx
const components = {
  heading: (props: HeadingProps) => <Heading {...props} className="text-balance" />,
  code: (props: CodeBlockProps) => <CodeFence {...props} showCopyButton />,
};

const inlineComponents = {
  kbd: ({ children }) => <kbd className="kbd">{children}</kbd>,
};

<StreamingMarkdown components={components} inlineComponents={inlineComponents} />;
```

## Scheduling & virtualization

The scheduler defaults mirror the demo (rAF batches, 9 ms frame budgets, queue depth-based adaptive throttle). Override via the `scheduling` prop to experiment with tighter budgets or microtask batches. Code blocks virtualize automatically above 200 lines; customize thresholds via the `components.code` renderer or pass a `virtualizedCode` config.

## Troubleshooting

- **Worker fails to load** – confirm `worker` prop points to a valid URL and the file is served with `Access-Control-Allow-Origin`.
- **Analyzer guardrail warnings** – run `npx tsx scripts/analyze-test-snippets.ts` locally; inspect `tmp/snippet_analysis/coalescing.csv` to understand which batches never coalesced.
- **Adaptive budget badge stuck** – heavy documents can flip the scheduler into throttled mode if coalescing p95 > 6 ms. Inspect the console metrics to ensure plugins aren’t emitting pathological patch streams.

Refer to `docs/STREAMING_MARKDOWN_QUICKSTART.md` and `docs/PUBLIC_API.md` for more examples until this README graduates from draft status.
