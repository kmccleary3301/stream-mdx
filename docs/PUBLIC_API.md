# Public API — StreamMDX

*Last updated: 2026-10-07*

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
- `stream-mdx/worker/engine` or `@stream-mdx/worker/engine` for isolated engines, an in-process Worker adapter, and custom worker entries
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
import { useRef } from "react";

export function Example() {
  const ref = useRef<StreamingMarkdownHandle>(null);
  return (
    <StreamingMarkdown
      ref={ref}
      text="## Hello\n\nStreaming **markdown**"
      engine="auto"
      worker="/workers/markdown-worker.js"
      features={{ tables: true, html: true, math: true, mdx: true }}
      mdxCompileMode="worker"
      prewarmLangs={["python", "bash"]}
      onMetrics={(metrics) => console.table(metrics.queueDelay)}
      onError={(error) => console.error(error)}
    />
  );
}
```

### Props

| Prop | Type | Notes |
| --- | --- | --- |
| `text` | `string` | Static markdown. Mutating it restarts the session. |
| `stream` | `AsyncIterable<string>` | Append-only stream; provide **either** `text` or `stream`. |
| `worker` | `WorkerLike` | Worker instance/URL/factory. When omitted, the component uses the default worker strategy and falls back to `/workers/markdown-worker.js`. |
| `engine` | `"worker" \| "main-thread" \| "auto"` | Default `"auto"`. Selects the browser worker or dynamically imported in-process engine. See execution modes below. |
| `managedWorker` | `boolean` | When `true`, the component attaches the worker but does not auto-`restart/append/finalize` for you (use the ref handle). |
| `prewarmLangs` | `string[]` | Shiki languages to load inside the worker. |
| `features` | `StreamingFeatureFlags` | Built-in parsing/highlighting flags, including `emitDiffBlocks`, `outputMode`, and `lazyTokenization`. |
| `themes` | `{ light: string; dark: string }` | Configures light and dark Shiki theme IDs (e.g. `{ light: "min-light", dark: "nord" }`). Changing themes re-initializes the engine. Unknown themes report an INIT error and fall back to GitHub light/dark. |
| `mdxCompileMode` | `MdxCompileMode` | Enables MDX compilation/hydration and selects the compile strategy. |
| `components` | `Partial<BlockComponents>` | Override block renders (wrap code/math without affecting the patch scheduler). |
| `inlineComponents` | `Partial<InlineComponents>` | Override inline renders. |
| `tableElements` | `Partial<TableElements>` | Override table tags (e.g. Shadcn table wrappers). |
| `tableVirtualization` | `boolean \| Partial<TableVirtualizationConfig>` | Opt-in row virtualization for large finalized tables. Default `false`. |
| `htmlElements` | `Partial<HtmlElements>` | Override HTML tag renders (when HTML is enabled). |
| `html` | `HtmlOptions` | Per-tag attribute allowlists and opt-in markdown parsing inside raw HTML blocks. Requires `features.html`. |
| `syntax` | `SyntaxRuleSpec[]` | Serializable regex rules for inline plugin nodes. Map rule names in `inlineComponents`. |
| `mdxComponents` | `Record<string, ComponentType>` | Component registry used when hydrating MDX. |
| `caret` | `CaretMode` | Show a streaming caret while blocks are still in-flight. |
| `linkSafety` | `{ enabled?, onLinkCheck?, renderModal? }` | Intercept links and require confirmation before navigation. Rejected URLs never navigate. |
| `urlTransform` | `UrlTransform` | Custom URL transformation callback `(url, attribute, context) => string \| null \| undefined`. Defaults to `defaultUrlTransform` from `@stream-mdx/core`. |
| `deferHeavyBlocks` | `DeferHeavyBlocks` | Defer heavy blocks (e.g. Mermaid) until in view/idle. |
| `codeRenderers` | `Record<string, CodeFenceRenderer>` | Language-keyed code fence components or `{ component, defer?, aliases? }`. Keys and aliases resolve case-insensitively. |
| `allowedElements` | `string[]` | Whitelist HTML tag names to allow (mutually exclusive with `disallowedElements`). Filtered at render time across markdown and raw HTML tags. |
| `disallowedElements` | `string[]` | Tag names to disallow (mutually exclusive with `allowedElements`). Removed tags drop subtrees unless `unwrapDisallowed` is enabled. |
| `allowElement` | `(element, context) => boolean` | Custom element filter callback. Receives `{ tagName, properties, blockType? }` and `{ source: "markdown" | "html", parentTagName? }`. |
| `unwrapDisallowed` | `boolean` | When true, disallowed tags render their child content in place instead of dropping their entire subtree. Default `false`. |
| `disableAutolinkProtocols` | `string[]` | Protocols (e.g. `["mailto"]`, case-insensitive, trailing colon optional) whose autolinks render as plain text. Explicit markdown links `[label](url)` remain links. |
| `mathRenderer` | `MathRenderer` | Replace inline/display KaTeX rendering without changing math parsing. |
| `artifactHtml` | `boolean` | Default `false`. Render ordinary `html` fences as artifacts; `artifact` and `html-artifact` fences already select `ArtifactFrame`. |
| `blockRenderer` | `BlockRendererOverride` | Finalized-block override receiving `{ block, element }`. Streaming blocks retain native rendering. |
| `scheduling` | `StreamingSchedulerOptions` | Patch scheduler/backpressure knobs. |
| `onMetrics` | `(metrics: RendererMetrics) => void` | Invoked after each flush (queue depth, timings, adaptive budget state, worker metrics). |
| `onError` | `(error: Error) => void` | Render-time errors. Updating the callback does not restart the engine or discard streamed content. (Worker runtime errors surface via `error` events on the Worker.) |
| `className`, `style` | React props forwarded to the root container. |
Notes:
- When `linkSafety.enabled` is on, the component replaces the `link` entry, including a supplied `inlineComponents.link`, with its confirmation-aware link renderer.
- Owned `text` renders initialize the complete document in one parse, then finalize the tail. Replacing text does not simulate chunked streaming. Rapid replacements match initialization acknowledgements in order; only the current source generation finalizes or reports a rejected initialization. Async iterators and imperative `append()` retain incremental parsing.
- Borrowed workers may be reused after detachment. Pending static calls reject on detach, but their initialization acknowledgement slots remain with the worker until drained; a later attachment cannot consume an older document's response as its own.

Type aliases:
- `type WorkerLike = Worker | URL | string | (() => Worker)`
- `type MdxCompileMode = "server" | "worker"`
- `type CaretMode = "block" | "circle" | string | false`
- `type DeferHeavyBlocks = boolean | { rootMargin?: string; idleTimeoutMs?: number; debounceMs?: number }`

### Execution modes and SSR

- `"worker"` requires browser `Worker` support and uses `worker` or the default worker strategy. It does not fall back to the main thread.
- `"main-thread"` dynamically imports `@stream-mdx/worker/engine` and creates an in-process Worker adapter. It ignores `worker` and runs parsing on the browser thread.
- `"auto"` first tries to construct a browser Worker. If Worker support is absent or construction fails, it dynamically imports the in-process engine. This fallback covers creation only, not later worker script loading, runtime errors, or failed `INIT` messages.

Engine creation runs in a React effect, not during SSR. Selecting `"main-thread"` does not compile server markup. For SSR/SSG, compile a snapshot with the Node/direct helper and render it with `@stream-mdx/react/server`. The default React import does not eagerly import the engine implementation. Applications still need a client boundary for `<StreamingMarkdown />`.

Changing `onError` uses the latest callback without restarting the engine or clearing streamed content. Worker protocol `ERROR` messages are distinct from browser Worker `error` events.

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

`restart()` clears the renderer-owned document and cancels the current iterator generation. It does not rewind a single-use iterator, including after EOF. Supply a fresh iterator to `stream` to begin another stream; reiterable sources that return fresh iterators are supported. Each actual iterator is consumed at most once during the component's mounted lifetime, including renderer/readiness changes. A pending `next()` may settle before cancellation closes that iterator; cancelled chunks are discarded.

Removing an open stream releases that generation's activity. It does not end a replacement iterator or an independently open imperative session; call `finalize()` to close imperative activity.

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

- `worker="/.../markdown-worker.js"`, `worker={new URL(...)}`, or `worker={() => createWorker()}`
  - StreamMDX creates + terminates the Worker instance for you. Factory-created workers are owned by the component.
- `worker={existingWorker}`
  - StreamMDX treats an existing Worker instance as externally managed and will not terminate it.
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
### Isolated engine and native extensions

`MarkdownEngine` owns its parser, document plugins, message queue, document state, and caches. Each instance emits `WorkerOut` messages through the required `post` callback:

```ts
import { MarkdownEngine } from "@stream-mdx/worker/engine";
import type { WorkerOut } from "@stream-mdx/core";

const messages: WorkerOut[] = [];
const engine = new MarkdownEngine({
  post: (message) => messages.push(message),
});

await engine.handle({ type: "INIT", docPlugins: { math: false } });
await engine.handle({ type: "APPEND", text: "# Hello\n\nOne document." });
await engine.handle({ type: "FINALIZE" });
// A new INIT resets document state and retains this instance's extensions.
await engine.handle({ type: "INIT", initialContent: "Another document." });
engine.dispose();
```

`handle(message: WorkerIn): Promise<void>` serializes protocol messages. Reset with `INIT`; there is no separate `reset()` or `emit()` method. `post(message: WorkerOut): void` sends through the supplied callback. `dispose(): void` releases instance state and stops further output.

The constructor accepts only `{ post, extensions? }`. `extensions` has `markdown?: MarkdownConfig[]`, `inline?: InlineExtension[]`, `documentPlugins?: DocumentPlugin[]`, and `syntax?: SyntaxRuleSpec[]`. Flags and HTML settings belong in `INIT`, not constructor options. Native extension functions cannot cross structured clone; bundle them into a custom worker entry with `serveMarkdownWorker({ extensions })`, or create an adapter with `createInlineEngineWorker({ extensions })` and supply it through a stable `worker={() => adapter}` factory in a Worker-capable browser. Do not pass the adapter directly as a Worker instance. The caller owns adapter termination. See [PLUGIN_ABI.md](./PLUGIN_ABI.md) for a complete custom entry.


---

## 3) Features

`features` toggles built-in capabilities in the worker + renderer:

- `tables`: GitHub-flavored markdown tables → table block snapshots (`tableElements` controls rendering).
- `html`: enables inline/raw HTML (sanitized by default; `htmlElements` controls rendering).
- `mdx`: recognizes MDX blocks (requires `mdxCompileMode` to compile/hydrate). A balanced JSX/MDX component whose native HTML block would be split by blank lines (for example `<SmokeBox>` … `</SmokeBox>`) stays one owning root and compiles as a single module; while it is still unclosed it remains a pending `html` root and is not compiled until it closes or the document finalizes.
- `math`: recognizes inline + display math (default delimiters: `$…$` and `$$…$$`).
- `footnotes`: enables footnote aggregation.
- `callouts`: enables callout blockquote syntax (disabled by default in the worker).
- `formatAnticipation`: (opt-in) withholds formatting markers while streaming (initial support: `*`, `**`, `` ` ``, `~~`). Final output is unchanged.
- `codeHighlighting`: controls Shiki strategy for fenced code blocks:
  - `"final"` (default): highlight only after the block finalizes.
  - `"incremental"`: highlight completed lines as they arrive (fast enough for streaming).
  - `"live"`: re-highlight on every update (slowest, highest fidelity).
- `themes`: optional `{ light: string; dark: string }` pair specifying Shiki bundled theme names.
  - Used across all highlight strategies (static, incremental, live, lazy, diff).
  - Loaded on demand into the shared worker highlighter singleton.
  - Shared highlighter caches are partitioned by theme pair to prevent cross-contamination between engines.
  - Invalid/unknown theme IDs report an error through the worker error pipeline and fall back to default GitHub light/dark themes.
### Context support table

| Feature | Browser worker streaming | Node snapshot compile | Edge/no-worker compile |
| --- | --- | --- | --- |
| `tables` | Yes | Yes | Preview |
| `html` | Yes (sanitized) | Yes (sanitized) | Preview |
| `math` | Yes | Yes | Preview |
| `mdx` | Yes (`server` or `worker` mode) | Yes (`server` compile mode) | Preview (`server` compile mode) |
| `footnotes` | Yes | Yes | Preview |
| `callouts` | Yes | Yes | Preview |
| Code themes (`themes`) | Yes | Yes | Preview |
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
import { StreamingMarkdown } from "@stream-mdx/react";

<StreamingMarkdown codeRenderers={{ mermaid: MermaidBlock }} />;
```

When registered, fenced `mermaid` code blocks render as diagrams (with a Diagram/Code toggle). All other code blocks remain unchanged.

### `createMermaidBlock(options?)`

Creates a customized Mermaid code fence renderer with isolated configuration, default views, debounce settings, custom error components, and custom Mermaid module instances or loaders:

```tsx
import { createMermaidBlock } from "@stream-mdx/mermaid";

const CustomMermaidBlock = createMermaidBlock({
  config: { theme: "neutral" },
  defaultView: "diagram", // "diagram" | "code"
  debounceMs: 150,
  mermaid: () => import("mermaid"), // optional custom/pinned instance or async loader
  errorComponent: ({ error, code, retry }) => (
    <div className="mermaid-error">
      <p>Error rendering diagram: {error}</p>
      <button type="button" onClick={retry}>Retry</button>
    </div>
  ),
});
```

Mermaid renders are serialized through an internal module queue so concurrent blocks with different factory configs do not interleave. Default `securityLevel: 'strict'` is preserved unless explicitly overridden in `config`. If `mermaid` is omitted, the block lazily imports `mermaid` on first diagram render.
## 3.2) Code Fence Renderers (`codeRenderers`)

Custom code fence rendering is registered via `codeRenderers` on `<StreamingMarkdown />` or `<MarkdownBlocksRenderer />`:

```tsx
import { ArtifactFrame, StreamingMarkdown } from "@stream-mdx/react";
import { MermaidBlock } from "@stream-mdx/mermaid";

export function CodeExample({ text }: { text: string }) {
  return (
    <StreamingMarkdown
      text={text}
      codeRenderers={{
        mermaid: MermaidBlock,
        artifact: (props) => <ArtifactFrame {...props} maxHeight="480px" />,
        custom: ({ language, renderCode }) => (
          <section><p>Language: {language}</p>{renderCode}</section>
        ),
      }}
    />
  );
}
```

### Code fence renderer contract
Language keys are trimmed and lowercased. Entries accept a component or `{ component: Component, defer?: boolean, aliases?: string[] }`; each alias resolves to the same renderer.

Language matching is case-insensitive (e.g. `JS` resolves to the `js` renderer). `defer: true` opts that renderer into viewport/idle deferral when `deferHeavyBlocks` is enabled.

interface CodeFenceRendererProps {
  code: string;
  language: string;
  meta?: Record<string, unknown>;
  info?: string;
  isFinalized?: boolean;
  blockId?: string;
  renderCode: React.ReactNode;
  openLink?: (url: string) => void;
}
```

`renderCode` is an already rendered React node, not a function. Return it directly when your custom view is unavailable. Explicit language renderers take precedence over built-in artifact/diff rendering and `components.code`.

With `features.emitDiffBlocks: true`, fences with diff metadata use `DefaultDiffRenderer`, including line numbers and token colors. Without diff metadata it returns `renderCode`. A custom language renderer overrides that view.

### Artifacts and math

`ArtifactFrame` keeps `renderCode` while streaming, then mounts finalized HTML in `<iframe sandbox="allow-scripts">`. It does not grant `allow-same-origin`. Its CSP precedes artifact content and defaults to `default-src 'none'`, inline scripts/styles, data/blob images, data fonts, `connect-src 'none'`, `base-uri 'none'`, and `form-action 'none'`. `csp` can explicitly permit additional resources; only `connectSrc` replaces rather than extends the defaults. Treat these overrides as application security policy.

The sandbox provides host DOM/origin isolation. The default CSP blocks connection APIs such as `fetch`, `XMLHttpRequest`, and `WebSocket`, and restricts resource loading. It is not a guarantee of total network isolation or prevention of iframe self-navigation. Use self-contained artifact content; link confirmation applies to the intercepted anchor-click path, not every navigation a script can initiate.

The frame accepts size/link messages only from its own `contentWindow`. Allowed outgoing links are absolute `http:`, `https:`, and `mailto:` URLs. `onLinkClick` takes precedence over `openLink`; the latter applies the host's `linkSafety`. Without either callback, links open with `noopener,noreferrer`. An `onLinkClick` override owns confirmation itself. `maxHeight?: number | string`, default `600`, caps the scrolling wrapper, not the measured iframe. `themeCssVars` supplies frame-local CSS variables.

Math uses KaTeX by default. `mathRenderer` accepts either a component with `{ tex: string; display?: boolean; className?: string }` or `{ inline?, display? }` components with `{ tex: string; className?: string }`. Unspecified entries retain their existing renderer. `features.math: false` disables math recognition, including inside opt-in HTML markdown. A render override does not re-enable parsing.

### Inline rules and HTML

`syntax` accepts `SyntaxRuleSpec[]` from `@stream-mdx/core`. Each rule emits a `"plugin"` inline node with a name, string attributes, optional parsed children, and raw matched text. Public `inlineComponents` maps that name to a React component receiving `{ name, attrs, children, raw }`. Unmapped rules use `inlineComponents.plugin` when present, otherwise raw matched text. Standard map keys include `text`, `strong`, `em`, `strike`, `code`, `link`, `image`, and `br`. See [PLUGIN_ABI.md](./PLUGIN_ABI.md) for capture, lookahead, anticipation, and invalid-`INIT` behavior.

`HtmlOptions` is `{ allowedTags?: Record<string, string[]>; literalTagContent?: string[] }`. `allowedTags` adds permitted tags and replaces their tag-specific attribute lists while retaining global schema attributes. URL protocol checks still apply to `href`/`src`/`action`/`formaction`/`xlink:href`; `script`/`style` tags remain excluded. `on*` event handler attributes and `srcdoc` are strictly forbidden and always stripped regardless of `allowedTags`. Raw HTML `style` attributes are sanitized using DOM-free safe property allowlists. Custom allowlists are trusted application policy. `htmlElements` maps permitted tag names to React components and supplies sanitized attributes and typed children.
Raw HTML block content is literal by default. Supplying `literalTagContent`, even `[]`, opts into engine-owned inline markdown parsing inside eligible HTML children. `code`, `pre`, and `textarea`, plus listed tags, stay literal. Inline syntax plugins and the engine's math flag apply to opt-in children; mapped components do not reparse strings. HTML must also be enabled via `features.html`.

## 3.3) Block Controls (Copy & Download)

StreamMDX provides opt-in, interactive block controls for code blocks, tables, and Mermaid diagrams via the `controls` prop on `<StreamingMarkdown />` and `<MarkdownBlocksRenderer />`. Controls are **disabled by default (`false`)**, guaranteeing byte-identical rendering for existing apps and baselines.

```tsx
import { StreamingMarkdown } from "@stream-mdx/react";

// Enable default controls across code, tables, and mermaid
<StreamingMarkdown text={markdown} controls />

// Fine-grained configuration:
<StreamingMarkdown
  text={markdown}
  controls={{
    code: { copy: true, download: true },
    table: { copy: true, download: ["csv", "tsv", "markdown"] },
    mermaid: { copy: true },
    labels: {
      copy: "Copy code",
      downloadCsv: "Download CSV",
    },
  }}
/>
```

### Features

- **Code blocks**: Copy button writes the raw authored code text directly to clipboard via `navigator.clipboard.writeText` (never highlighted HTML). Download saves `snippet.<ext>` matching the authored fence language (e.g. `.ts`, `.py`, `.rs`, `.sql`). Fully compatible with virtualized code.
- **Tables**: Copy as TSV (ready to paste into spreadsheets) or Markdown. Download as CSV, TSV, or Markdown with strict RFC 4180 escaping (quotes, commas, newlines). Table controls are enabled only once the table block is finalized; streaming tables show disabled controls.
- **Mermaid / Code Fences**: Exposed through `CodeFenceRendererProps` (`controls` flags and `copy()` helper). `MermaidBlock` opts in to source diagram code copying in its toolbar and code view.
- **Accessibility & SSR**: Buttons are real `<button type="button">` with `aria-label`, `data-stream-mdx-control`, and semantic classes. Rendering is 100% SSR-safe (no `window` access during render).
- **Replacement slot**: Fully replaceable via `controlsComponent` prop on `<StreamingMarkdown />` or `ComponentRegistry.setControlsComponent()`.

## 3.4) Animated Streaming (`animated`)

StreamMDX provides opt-in, per-word or per-character streaming text animation via the `animated` prop on `<StreamingMarkdown />` and `<MarkdownBlocksRenderer />`.

Animation is **disabled by default**, guaranteeing zero overhead on the hot path and byte-identical DOM output for static and existing renders.

```tsx
import { STREAM_MDX_ANIMATION_CSS, StreamingMarkdown } from "@stream-mdx/react";

// Include the stylesheet once in your app or inject the exported CSS constant
<style dangerouslySetInnerHTML={{ __html: STREAM_MDX_ANIMATION_CSS }} />

// Default animation (fadeIn, 150ms, ease-out, per-word, 20ms stagger):
<StreamingMarkdown stream={stream} animated />

// Custom options:
<StreamingMarkdown
  stream={stream}
  animated={{
    animation: "blurIn", // "fadeIn" | "blurIn" | "slideUp" | custom animation name
    duration: 180,       // Duration in ms
    easing: "ease-out",  // Timing function
    sep: "word",         // "word" | "char"
    stagger: 20,         // Delay between successive tokens (ms)
    maxBacklogMs: 320,   // Maximum cumulative delay cap (ms)
  }}
/>
```

### Mechanics

- **Streaming only**: Animation applies only while blocks are streaming (non-finalized). Once a block finalizes, or during static / SSR rendering, it outputs plain text without animation wrapper spans.
- **Stable DOM identities**: When enabled, inline text nodes render as keyed `<span>` elements keyed by segment index within the text node. Appending new text updates the DOM incrementally without remounting or re-animating previously rendered words.
- **CSS variables**: Each newly mounted span receives class `stream-mdx-anim` and CSS variables `--sm-anim-duration`, `--sm-anim-easing`, and `--sm-anim-delay`.
- **Timeline & backlog capping**: Delay is tracked per renderer in an isolated timeline object. If a large burst of text arrives in a single flush, `stagger` compresses so the cascade stays capped within `maxBacklogMs`.
- **Reduced motion**: `STREAM_MDX_ANIMATION_CSS` includes `@media (prefers-reduced-motion: reduce)` which disables animation automatically.
## 3.5) Remark & Rehype Adapter (`@stream-mdx/unified`)
`@stream-mdx/unified` provides an adapter for existing `remarkPlugins` and `rehypePlugins`.

```bash
npm install @stream-mdx/unified
```

Unified plugins execute only on finalized blocks. Streaming blocks retain the native renderer.

```tsx
import { StreamingMarkdown } from "@stream-mdx/react";
import { createUnifiedRenderer } from "@stream-mdx/unified";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";

const unifiedRenderer = createUnifiedRenderer({
  rehypePlugins: [rehypeSlug, rehypeAutolinkHeadings],
  blockTypes: ["paragraph", "heading"],
  components: {
    a: (props) => <a {...props} className="external-link" />,
  },
});

export function Article({ markdown }: { markdown: string }) {
  return <StreamingMarkdown text={markdown} blockRenderer={unifiedRenderer} />;
}
```
Explicit `blockTypes` replaces the default routing list. Routed lists and blockquotes replace native container children, including prepared nested snapshots, with the unified result. Exclude those containers to retain native code, math, HTML, and syntax components inside them. A successful `blockRenderer` replacement has precedence over that block's native rendering.


### Options

- `remarkPlugins`: List of remark plugins or tuples `[plugin, options]`
- `rehypePlugins`: List of rehype plugins or tuples `[plugin, options]`
- `components`: Custom React component mapping passed to `hast-util-to-jsx-runtime`
- `blockTypes`: Block types to route through unified (defaults to all standard blocks: `paragraph`, `heading`, `blockquote`, `list`, `table`, `code`, `thematicBreak`). Specialized block types like `html` and `mdx` are opt-in via `blockTypes`.
- `cacheSize`: Maximum number of rendered blocks to retain in LRU cache (default: `500`)
- `math`: Enable math syntax (`remark-math`)
- `gfm`: Enable GitHub Flavored Markdown (`remark-gfm`, default: `true`)
- `onError`: Explicit error callback `(error: Error, block: Block) => void` for plugin failures (prevents unhandled rejections and falls back to default rendered element)
- `urlTransform`: Custom URL transformation callback `(url: string, attribute: "href" | "src", context: { source: "markdown" | "html" }) => string | null | undefined`. Applied during a final HAST post-processing pass after all user rehype plugins without stripping classes. Defaults to `defaultUrlTransform`.

### Sync vs. Async Behavior & SSR
- **Sync Plugins**: Executed synchronously in `useMemo`. Produces immediate markup in SSR (`renderToStaticMarkup`, `renderToString`) with zero duplicated execution.
- **Async Plugins**: Processed off the streaming critical path. During SSR or initial client render, the default StreamMDX rendered element is retained while the async job is pending. Once complete, the transformed block is committed.
- **Deduplication and stale results**: Multiple render passes for the same cache key share in-flight jobs. Old jobs may finish, but cannot replace a newer block's rendered result. Keys include block ID/type, reconstructed markdown, and resolved link references.

Create the renderer once for each stable plugin configuration, outside render or in `useMemo`. Each renderer has its own bounded cache. Recreate it when plugin options change. `unifiedRenderer.clearCache(): void` clears completed results and the in-flight lookup; it does not abort plugin execution already running. Failed jobs call `onError(error, block)` when supplied and retain the native element; otherwise the adapter logs the error.
## 3.6) Table row virtualization (`tableVirtualization`)
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
- Only mounted, finalized tables at or above `minRows` virtualize, and only when the surrounding streaming session is inactive. A completed table followed by an unfinished paragraph stays fully rendered. Imperative `append()` opens a session; `finalize()` closes it when no async iterator is active. Normal iterator EOF finalizes the tail and closes its session. Imperative append/finalize still works after EOF or after removing the stream prop; an unconsumed stream prop does not own a session.
- Replacing `text`, replacing an iterator, or calling `restart()` clears the renderer-owned engine document using its existing initialization options. Old iterator generations cannot finalize the replacement session. With `managedWorker`, the caller owns engine initialization: restart clears the renderer store without sending `INIT` or discarding the caller's engine document.
- The scroll container has a native sticky `<thead>` and an accessible name. Spacer rows are `aria-hidden`. Only mounted body rows appear in the accessibility tree; disable virtualization when every row must be available to assistive technology, browser find, or printing.
- The initial full table uses native automatic column sizing. Measured column widths then populate an explicit `<colgroup>` while rows are windowed. Container width changes trigger another full-table natural-layout pass and invalidate cached row heights. A `ResizeObserver` measures mounted multiline rows and later content resizes.
- Disabling virtualization or replacing its native table/header invalidates natural column widths and every cached row height. Re-enabling measures the complete current table even at unchanged viewport width. Adapter replacement rebinds observers to the current native table, header, and mounted rows; detached-node callbacks cannot update the new measurement generation.
- Row keys and `data-row-id` values stay stable as the window changes. Spacer heights account for omitted rows. Scrolling to the bottom mounts the final row.
- Custom `tableElements` render the table, sections, cells, and spacers. They must forward DOM props and preserve native table tags. Existing overflow-wrapped Table adapters are supported. Only scroll/clipping wrappers between the native table and the owned viewport temporarily receive `overflow: visible !important`; the outer viewport owns both scroll axes. Original overflow shorthand/longhand declarations and priorities are restored in their original order on disable/unmount. Unrelated inline styles remain untouched; inline overflow changes made by the component while managed transfer cleanup ownership to the component.
- Changing or removing `tableVirtualization` updates the existing view without restarting the parser. `maxHeight` limits the outer scroll container and `overscan` is clamped to 1–50 rows on each side.
- Sticky headers have an opaque background taken from the nearest opaque ancestor, or the CSS system color `Canvas`. Theme class/style changes update that fallback. Set `--stream-mdx-table-header-background` to a valid opaque CSS color to override it, not an HSL channel-only token.

Try `/showcase/table-virtualization` in the docs app. It contains up to 500 rows with two- and three-line descriptions, live configuration controls, and a "Scroll to Last Row" button. Viewport navigation controls are disabled when virtualization is off, and wait for the current source to finalize and its virtualized viewport to finish the natural-layout pass. The page names the expected final record.

### Configuration Options (`TableVirtualizationConfig`)

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `false` | Enable or disable table row virtualization. |
| `minRows` | `number` | `40` | Minimum body rows required to trigger virtualization (alias: `virtualizeThreshold`). |
| `estimatedRowHeight` | `number` | `40` | Estimated height in pixels for unmeasured rows. |
| `overscan` | `number` | `8` | Number of buffer rows rendered above and below the viewport (bounded 1-50). |
| `maxHeight` | `number \| string` | `"600px"` | Maximum height of the scroll container. |
## 3.7) Math Rendering (`mathRenderer`)
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
## 3.5) Element Filtering and Autolink Protocols

StreamMDX mirrors Streamdown / react-markdown element filtering semantics:

- `allowedElements`: Whitelist tag names to render (e.g. `["p", "a", "strong"]`). Mutually exclusive with `disallowedElements` (throws if both are supplied).
- `disallowedElements`: Blacklist tag names to remove (e.g. `["img", "script"]`). Removed tags drop their entire subtree by default.
- `unwrapDisallowed`: When `true`, disallowed elements render their children in place rather than dropping the subtree (e.g. `<em>text</em>` renders as `text`).
- `allowElement`: Fine-grained predicate `(element: ElementFilterDescriptor, context: ElementFilterContext) => boolean`. Receives `{ tagName, properties, blockType? }` and `{ source: "markdown" | "html", parentTagName? }`. Returning `false` disallows the element.
- `disableAutolinkProtocols`: Protocols to disable for autolinks (e.g. `["mailto"]`). Autolinked URLs/emails using these protocols render as plain text instead of links. Explicit markdown links `[contact](mailto:...)` remain links. Protocols can be specified with or without a trailing colon and are matched case-insensitively.

Filtering applies consistently at render time across client streaming, client node views, SSR (`@stream-mdx/react/server`), and raw HTML blocks/inlines.

```tsx
<StreamingMarkdown
  text={markdown}
  disallowedElements={["img"]}
  unwrapDisallowed={true}
  disableAutolinkProtocols={["mailto"]}
  allowElement={(element, context) => {
    if (context.source === "html" && element.tagName === "iframe") {
      return false;
    }
    return true;
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
