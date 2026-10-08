# Public API — StreamMDX

*Last updated: 2026-02-11*

## Packages & Entry Points

StreamMDX is published as both scoped packages and an unscoped convenience wrapper:

| Package | Use when… |
| --- | --- |
| `stream-mdx` | You want a single dependency and stable import paths (recommended for apps). |
| `@stream-mdx/react` | You want the React surface without the wrapper. |
| `@stream-mdx/worker` | You want the worker client + hosted worker bundle (browser + Node). |
| `@stream-mdx/core` | You want types + perf/sanitization helpers (no React). |
| `@stream-mdx/mermaid` | You want optional Mermaid diagrams for fenced `mermaid` code blocks. |
| `@stream-mdx/unified` | You want remark/rehype plugins (runs on finalized blocks). |
| `@stream-mdx/plugins/*` | You are building/customizing a worker bundle or need plugin primitives. |

When you install `stream-mdx`, you can also import:

- `stream-mdx/react`, `stream-mdx/worker`, `stream-mdx/core`
- `stream-mdx/worker/node` (Node `worker_threads` helper)
- `stream-mdx/worker/direct` (in-process compile helper for runtimes without `worker_threads`)
- `stream-mdx/plugins/*` (common plugin entrypoints; useful for pnpm users)

## Runtime Context Matrix

| Context | Primary API | Compile path | Determinism status |
| --- | --- | --- | --- |
| Browser streaming UI | `<StreamingMarkdown />` from `stream-mdx` or `@stream-mdx/react` | Web Worker (`/workers/markdown-worker.js`) | Supported + CI-covered |
| Node SSR/SSG | `compileMarkdownSnapshot()` from `stream-mdx/worker/node` + `MarkdownBlocksRenderer` from `@stream-mdx/react/server` | `worker_threads` hosted worker | Supported + parity-tested |
| Static export docs build | `scripts/compile-docs-snapshots.ts` | Node snapshot compile at build time | Supported + Vercel-parity-tested |
| Edge/no-`worker_threads` runtime | `compileMarkdownSnapshotDirect()` from `stream-mdx/worker/direct` + `MarkdownBlocksRenderer` from `@stream-mdx/react/server` | In-process direct worker runtime bridge (no `worker_threads`) | Preview + parity-tested + cache-compatible (Node FS) |

Determinism scope for supported rows:
- same input text
- same init/config
- same worker/compiler bundle hash
- same dependency set

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
| `worker` | `WorkerLike` | Worker instance/URL/factory. When omitted, the component uses the default worker strategy and falls back to `/workers/markdown-worker.js`. |
| `managedWorker` | `boolean` | When `true`, the component attaches the worker but does not auto-`restart/append/finalize` for you (use the ref handle). |
| `prewarmLangs` | `string[]` | Shiki languages to load inside the worker. |
| `features` | `{ footnotes?, html?, mdx?, tables?, callouts?, math?, formatAnticipation?, codeHighlighting? }` | Toggles built-in feature flags. |
| `mdxCompileMode` | `MdxCompileMode` | Enables MDX compilation/hydration and selects the compile strategy. |
| `components` | `Partial<BlockComponents>` | Override block renders (wrap code/math without affecting the patch scheduler). |
| `inlineComponents` | `Partial<InlineComponents>` | Override inline renders. |
| `tableElements` | `Partial<TableElements>` | Override table tags (e.g. Shadcn table wrappers). |
| `tableVirtualization` | `boolean \| Partial<TableVirtualizationConfig>` | Opt-in row virtualization for large finalized tables. Default `false`. |
| `htmlElements` | `Partial<HtmlElements>` | Override HTML tag renders (when HTML is enabled). |
| `mdxComponents` | `Record<string, ComponentType>` | Component registry used when hydrating MDX. |
| `caret` | `CaretMode` | Show a streaming caret while blocks are still in-flight. |
| `linkSafety` | `{ enabled?, onLinkCheck?, renderModal? }` | Intercept links and require confirmation before navigation. |
| `deferHeavyBlocks` | `DeferHeavyBlocks` | Defer heavy blocks (e.g. Mermaid) until in view/idle. |
| `scheduling` | `StreamingSchedulerOptions` | Patch scheduler/backpressure knobs. |
| `onMetrics` | `(metrics: RendererMetrics) => void` | Invoked after each flush (queue depth, timings, adaptive budget state, worker metrics). |
| `onError` | `(error: Error) => void` | Render-time errors. Updating the callback does not restart the engine or discard streamed content. (Worker runtime errors surface via `error` events on the Worker.) |
| `className`, `style` | React props forwarded to the root container. |

Notes:
- When `linkSafety.enabled` is on, the default `link` inline renderer is overridden to ensure clicks are intercepted. If you supply a custom `inlineComponents.link`, wrap link safety yourself.

Type aliases:
- `type WorkerLike = Worker | URL | string | (() => Worker)`
- `type MdxCompileMode = "server" | "worker"`
- `type CaretMode = "block" | "circle" | string | false`
- `type DeferHeavyBlocks = boolean | { rootMargin?: string; idleTimeoutMs?: number; debounceMs?: number }`

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

For runtimes without `worker_threads` (edge-style constraints), use:

- `@stream-mdx/worker/direct` (scoped)
- `stream-mdx/worker/direct` (convenience wrapper)

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
- `formatAnticipation`: (opt-in) withholds formatting markers while streaming (initial support: `*`, `**`, `` ` ``, `~~`). Final output is unchanged.
- `codeHighlighting`: controls Shiki strategy for fenced code blocks:
  - `"final"` (default): highlight only after the block finalizes.
  - `"incremental"`: highlight completed lines as they arrive (fast enough for streaming).
  - `"live"`: re-highlight on every update (slowest, highest fidelity).

### Context support table

| Feature | Browser worker streaming | Node snapshot compile | Edge/no-worker compile |
| --- | --- | --- | --- |
| `tables` | Yes | Yes | Preview |
| `html` | Yes (sanitized) | Yes (sanitized) | Preview |
| `math` | Yes | Yes | Preview |
| `mdx` | Yes (`server` or `worker` mode) | Yes (`server` compile mode) | Preview (`server` compile mode) |
| `footnotes` | Yes | Yes | Preview |
| `callouts` | Yes | Yes | Preview |
| Mermaid addon (`@stream-mdx/mermaid`) | Yes (renderer component) | Yes (renderer component) | Preview (renderer component) |
| Unified adapter (`@stream-mdx/unified`) | Yes (blockRenderer) | Yes (blockRenderer) | Yes (blockRenderer) |

---

## 3.1) Mermaid (optional)

Mermaid diagrams are provided as an **opt-in addon** via `@stream-mdx/mermaid`.

```bash
npm install @stream-mdx/mermaid
```

```tsx
import { MermaidBlock } from "@stream-mdx/mermaid";

<StreamingMarkdown codeRenderers={{ mermaid: MermaidBlock }} />;
```

When registered, fenced `mermaid` code blocks render as diagrams (with a Diagram/Code toggle). All other code blocks remain unchanged.

## 3.2) Code Fence Renderers (`codeRenderers`)

Custom code fence rendering is registered via `codeRenderers` on `<StreamingMarkdown />` or `<MarkdownBlocksRenderer />`:

```tsx
import { ArtifactFrame } from "@stream-mdx/react";
import { MermaidBlock } from "@stream-mdx/mermaid";

<StreamingMarkdown
  codeRenderers={{
    mermaid: MermaidBlock,
    artifact: ArtifactFrame,
    custom: ({ code, language, isFinalized, renderCode }) => (
      <div>Language: {language}</div>
    ),
    heavy: {
      component: HeavyDiagramComponent,
      defer: true, // opts in to deferHeavyBlocks viewport deferral
    },
  }}
/>

## 3.3) Remark & Rehype Adapter (`@stream-mdx/unified`)

`@stream-mdx/unified` provides an adapter for existing `remarkPlugins` and `rehypePlugins`.

```bash
npm install @stream-mdx/unified
```

Unified plugins execute **only on finalized blocks** (blocks that will not receive further streaming input). While a block is streaming, the high-performance Lezer-native StreamMDX engine renders it without blocking.

```tsx
import { StreamingMarkdown } from "@stream-mdx/react";
import { createUnifiedRenderer } from "@stream-mdx/unified";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";

const unifiedRenderer = createUnifiedRenderer({
  rehypePlugins: [rehypeSlug, rehypeAutolinkHeadings],
  components: {
    a: (props) => <a {...props} className="external-link" />,
  },
});

export function Article({ markdown }: { markdown: string }) {
  return <StreamingMarkdown text={markdown} blockRenderer={unifiedRenderer} />;
}
```

### Options

- `remarkPlugins`: List of remark plugins or tuples `[plugin, options]`
- `rehypePlugins`: List of rehype plugins or tuples `[plugin, options]`
- `components`: Custom React component mapping passed to `hast-util-to-jsx-runtime`
- `blockTypes`: Block types to route through unified (defaults to all standard blocks: paragraph, heading, blockquote, list, table, code, hr)
- `cacheSize`: Maximum number of rendered blocks to retain in LRU cache (default: `500`)
- `math`: Enable math syntax (`remark-math`)
- `gfm`: Enable GitHub Flavored Markdown (`remark-gfm`, default: `true`)
- `onError`: Explicit error callback `(error: Error, block: Block) => void` for plugin failures (prevents unhandled rejections and falls back to default rendered element)

### Sync vs. Async Behavior & SSR
- **Sync Plugins**: Executed synchronously in `useMemo`. Produces immediate markup in SSR (`renderToStaticMarkup`, `renderToString`) with zero duplicated execution.
- **Async Plugins**: Processed off the streaming critical path. During SSR or initial client render, the default StreamMDX rendered element is retained while the async job is pending. Once complete, the transformed block is committed.
- **Deduplication & Cancellation**: Multiple render passes for the same block/cacheKey reuse in-flight jobs. If block content or link references update before an async job finishes, stale jobs are cancelled and will not overwrite newer metadata.
### CodeFenceRenderer contract
- **Language lookup**: Case-insensitive and trimmed (`"ts"`, `"TS"`, `"python"`).
- **Renderer shape**: `Component | { component: Component; defer?: boolean }`.
- **Props passed**:
  - `code`: Un-fenced source code string.
  - `language`: Normalized language string.
  - `meta`: Block payload metadata object.
  - `info`: Code fence info string.
  - `isFinalized`: Boolean indicating if streaming for this block has finished.
  - `blockId`: Unique block ID.
  - `renderCode`: Pre-rendered fallback code view element.
  - `openLink`: Host link handler. Under `StreamingMarkdown` it applies `linkSafety`; renderers that surface links should call it.

### Built-in Renderers
1. **ArtifactFrame (P4)**: Built-in sandboxed iframe renderer for fence languages `artifact` and `html-artifact` (and `html` with `artifactHtml: true`). Displays fallback code view while streaming; once finalized, mounts an isolated `<iframe sandbox="allow-scripts" srcdoc="...">` with strict CSP meta (`connect-src 'none'`), auto-height messaging, and links routed through `onLinkClick` or `openLink` (only `http:`, `https:`, `mailto:`).
2. **DefaultDiffRenderer**: When a code block payload includes `meta.diffBlocks` (from worker `features.emitDiffBlocks`), it automatically renders a structured git diff table with line kinds, old/new line numbers, and token colors. Overridable via `codeRenderers={{ diff: CustomDiff }}`.

## 3.3) Table row virtualization (`tableVirtualization`)

Opt in to render a viewport-sized subset of a large finalized table. Server rendering and active streaming still render every row. This option does not change parsing or discard row content.

```tsx
<StreamingMarkdown
  text={content}
  tableVirtualization={{
    enabled: true,
    minRows: 40,
    estimatedRowHeight: 44,
    overscan: 8,
    maxHeight: "600px",
  }}
/>
```

### Rendering behavior

- Disabled by default. `true` enables the defaults; an options object enables virtualization unless `enabled` is `false`.
- Only mounted, finalized tables at or above `minRows` virtualize, and only when the surrounding streaming session is inactive. A completed table followed by an unfinished paragraph stays fully rendered. Imperative `append()` opens a session; `finalize()` closes it. An async iterator owns its session until the iterator finishes.
- The scroll container has a native sticky `<thead>` and an accessible name. Spacer rows are `aria-hidden`. Only mounted body rows appear in the accessibility tree; disable virtualization when every row must be available to assistive technology, browser find, or printing.
- The initial full table uses native automatic column sizing. Measured column widths then populate an explicit `<colgroup>` while rows are windowed. Container width changes trigger another full-table natural-layout pass and invalidate cached row heights. A `ResizeObserver` measures mounted multiline rows and later content resizes.
- Row keys and `data-row-id` values stay stable as the window changes. Spacer heights account for omitted rows. Scrolling to the bottom mounts the final row.
- Custom `tableElements` render the table, sections, cells, and spacers. They must forward DOM props and preserve native table tags. Existing overflow-wrapped Table adapters are supported. Only scroll/clipping wrappers between the native table and the owned viewport temporarily receive `overflow: visible !important`; the outer viewport owns both scroll axes. Original overflow shorthand/longhand declarations and priorities are restored in their original order on disable/unmount. Unrelated inline styles remain untouched; inline overflow changes made by the component while managed transfer cleanup ownership to the component.
- Changing or removing `tableVirtualization` updates the existing view without restarting the parser. `maxHeight` limits the outer scroll container and `overscan` is clamped to 1–50 rows on each side.
- Sticky headers have an opaque background taken from the nearest opaque ancestor, or the CSS system color `Canvas`. Theme class/style changes update that fallback. Set `--stream-mdx-table-header-background` to a valid opaque CSS color to override it, not an HSL channel-only token.

Try `/showcase/table-virtualization` in the docs app. It contains up to 500 rows with two- and three-line descriptions, live configuration controls, and a "Scroll to Last Row" button. The page names the expected final record.

### Configuration Options (`TableVirtualizationConfig`)

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `false` | Enable or disable table row virtualization. |
| `minRows` | `number` | `40` | Minimum body rows required to trigger virtualization (alias: `virtualizeThreshold`). |
| `estimatedRowHeight` | `number` | `40` | Estimated height in pixels for unmeasured rows. |
| `overscan` | `number` | `8` | Number of buffer rows rendered above and below the viewport (bounded 1-50). |
| `maxHeight` | `number \| string` | `"600px"` | Maximum height of the scroll container. |

## 3.3) Math Rendering (`mathRenderer`)

StreamMDX includes first-party KaTeX math rendering by default for inline (`$...$`) and display (`$$...$$`) math.

To override or use MathJax:
```tsx
<StreamingMarkdown
  mathRenderer={{
    inline: ({ tex }) => <span className="mathjax-inline">\({tex}\)</span>,
    display: ({ tex }) => <div className="mathjax-display">\[{tex}\]</div>,
  }}
/>
```

## 4) MDX Compilation Modes

`mdxCompileMode` selects how MDX blocks are compiled:

- `"worker"`: compilation happens client-side in the worker.
- `"server"`: compilation requests go to `/api/mdx-compile-v2` by default (you must implement this endpoint in your app).

See `docs/REACT_INTEGRATION_GUIDE.md` for a complete Next.js wiring guide and parity notes.

### Next.js App Router (server-safe rendering)

```tsx
import { MarkdownBlocksRenderer, ComponentRegistry } from "@stream-mdx/react/server";
import { compileMarkdownSnapshot } from "stream-mdx/worker/node";

export default async function Page() {
  const { blocks } = await compileMarkdownSnapshot({
    text: "# Hello\\n\\nStreaming-safe server render.",
    init: {
      docPlugins: { tables: true, html: true, mdx: true, math: true, footnotes: true },
      mdx: { compileMode: "server" },
      prewarmLangs: ["typescript"],
    },
  });

  return <MarkdownBlocksRenderer blocks={blocks} componentRegistry={new ComponentRegistry()} />;
}
```

### Static build pipeline (SSG/export)

Use a build-time step to compile markdown into snapshot artifacts, then render those blocks in routes:

```bash
npm run docs:snapshots:build
```

This is the same model used by `apps/docs` before `next build`/export.

### Direct compile helper (no `worker_threads`)

```tsx
import { MarkdownBlocksRenderer, ComponentRegistry } from "@stream-mdx/react/server";
import { compileMarkdownSnapshotDirect } from "stream-mdx/worker/direct";

export default async function EdgeLikePage() {
  const { blocks } = await compileMarkdownSnapshotDirect({
    text: "# Hello\\n\\nEdge-safe deterministic compile.",
    init: {
      docPlugins: { tables: true, html: true, mdx: true, math: true, footnotes: true },
      mdx: { compileMode: "server" },
      prewarmLangs: ["typescript"],
    },
    cache: {
      dir: ".stream-mdx-cache",
    },
  });

  return <MarkdownBlocksRenderer blocks={blocks} componentRegistry={new ComponentRegistry()} />;
}
```

Notes:
- Cache semantics match `compileMarkdownSnapshot()` when the runtime exposes Node filesystem APIs.
- In edge isolates without filesystem access, direct compile still runs deterministically and skips cache IO.

---

## 5) Metrics & Scheduling

### `onMetrics`

`onMetrics` receives `RendererMetrics` after each flush. The payload includes queue depth, queue delay distribution, worker patch metrics, and the adaptive throttling state.

Adaptive throttling is based on coalescing p95 thresholds:

- activates when coalescing p95 > **6ms**
- deactivates when coalescing p95 < **4ms**

### `scheduling`

`scheduling` (a subset of the patch scheduler options) includes:

- `frameBudgetMs` (default: 10)
- `lowPriorityFrameBudgetMs` (default: 6; derived from the frame budget when unspecified)
- `maxBatchesPerFlush` (default: 12)
- `maxLowPriorityBatchesPerFlush` (default: 2)
- `urgentQueueThreshold` (default: 4)
- `batch` (`"rAF" | "timeout" | "microtask"`, default: `"microtask"` when available)
- `adaptiveSwitch` (default: `true` when `batch` is `"microtask"`) — switch to a smooth rAF preset once the queue drains
- `adaptiveQueueThreshold` (default: `maxBatchesPerFlush` or 12) — queue size threshold for switching
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
