# Public API — StreamMDX

*Last updated: 2026-10-23*

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

### Core parser and snapshot contracts

`@stream-mdx/core` retains `InlineParser`, its extension/configuration types, the streaming preparation APIs, and `prepareNestedBlockSnapshot`. Worker integrations also retain `createBlockCompatibilityExtension`, `extractLezerCode`, `collectLinkReferences`, and `diffLinkReferences`. `compileSyntaxRuleToExtension` remains available for native inline extension registration.

The Lezer converter, math extension factory, link-label normalization, entity decoder, and default/regex plugin adapter helpers are implementation details, not root exports.

`createBlockSnapshot(block)` uses `block.payload.meta.preparedNested` when present, preserving the owning parser's registered extensions. Without prepared data, container snapshots use the built-in parser and honor `block.payload.meta.mathEnabled`, including `false`. This fallback cannot recover registered extensions or reference definitions that were not stored in the block. Prepare nested snapshots with the owning parsers before serialization when those settings matter; the snapshot function takes no additional parser/configuration argument.

Live worker `INITIALIZED` snapshots include the root `NodeSnapshot.inputSource`
baseline, whose generation matches the message generation; an empty raw baseline
is valid. Every later admitted chunk arrives as an ordered semantic
`appendInputSource` root patch with its exact UTF-16 offset and newly admitted
text. Consumers must reject a live initialization without this baseline before
resetting prior state. Standalone `Block[]` and cold snapshots may omit it and
retain honest per-block raw slices; they do not reconstruct missing document
gaps. Root input generation is independent of native code, table, and paragraph
owner generations. Source retention does not signal semantic completion.

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
      features={{ tables: true, html: true, math: true }}
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
| `engine` | `"auto" \| "main" \| "worker"` | Default `"auto"`. Selects automatic (`"auto"`; the default), inline (`"main"`), or dedicated-worker (`"worker"`) execution. See execution modes below. |
| `managedWorker` | `boolean` | Requires a supplied Worker instance or caller-accessible factory. The caller sends `INIT` and document commands; automatic commands are disabled. URL/default workers and internally created main-thread engines are rejected. Factory workers remain component-owned; supplied instances remain caller-owned. |
| `prewarmLangs` | `string[]` | Shiki languages to load inside the worker. |
| `features` | `StreamingFeatureFlags` | Built-in parsing/highlighting flags: `softBreaks?: "preserve" | "hard"` (default `"preserve"`), `emitDiffBlocks`, `outputMode` (`"html"`, `"tokens"`, or `"both"`), and `lazyTokenization`. `"hard"` turns prose soft line endings into `<br>` nodes; code, math, and raw HTML are unchanged. |
| `themes` | `{ light: string | ThemeRegistration; dark: string | ThemeRegistration }` | Configures light and dark Shiki themes by ID or serializable theme registration. Changing themes re-initializes the engine. Unknown theme IDs report an INIT error and fall back to GitHub light/dark. |
| `highlightEngine` | `"javascript" | "oniguruma"` | Selects Shiki's JavaScript regex engine or the Oniguruma WASM engine. Defaults to `"javascript"`. |
| `engineExtensions` | `EngineExtensions` | Supplies native extensions to the in-process engine used by `engine="main"` and the `"auto"` bootstrap. Requires `extensionId`; unavailable with `engine="worker"` because extension functions are not serializable. |
| `extensionId` | `string` | Caller-supplied identity for the bundled extension set. Used for worker compatibility and snapshot cache identity; function source is never hashed. |
| `mathOptions` | `MathOptions` | `singleDollar?: "permissive" | "currency-safe"` controls parser admission for single-dollar math; defaults to `"permissive"`. Display math is unaffected. |
| `linkDestinations` | `LinkDestinationOptions` | `windowsDrivePaths?: "commonmark" | "preserve"` retains backslashes for absolute Windows drive and UNC link, image, and reference-definition destinations when set to `"preserve"`. Other destinations keep CommonMark escape decoding. |
| `contentPolicy` | `"markdown" \| "restricted" \| "trusted-mdx"` | Defaults to `"restricted"`. Full MDX evaluation requires `"trusted-mdx"` and an explicit engine. |
| `contentComponents` | `ContentComponentsMap` | Host registrations for restricted source components. Separate from native Markdown presentation overrides. |
| `engines.mdx` | `TrustedMdxEngine` | Explicit evaluator required with `contentPolicy="trusted-mdx"`. |
| `engines.math` | `MathEngine` | Synchronous, server-render-safe TeX adapter. KaTeX remains the default when omitted. |
| `engines.mermaid` | `MermaidEngine` | Main-thread presentation engine for Mermaid code fences. |
| `engines.code` | `CodeEngine` | Custom code-line tokenization. Main-realm only; requires `engine="main"`. |
| `components` | `NodePresentations` | Semantic block, inline, extension, and HTML wrappers or headless views. |
| `tableVirtualization` | `boolean \| Partial<TableVirtualizationConfig>` | Opt-in row virtualization for large tables while streaming or finalized. Default `false`; configured thresholds and overscan remain in effect during streaming. |
| `codeVirtualization` | `Partial<VirtualizedCodeConfig>` | Configures the native code viewport. Code blocks over the default 200-line threshold are windowed; the full-content control is explicit. |
| `html` | `HtmlOptions` | Per-tag attribute allowlists and opt-in markdown parsing inside raw HTML blocks. Requires `features.html`. |
| `syntax` | `SyntaxExtensionDescriptor` | Versioned descriptor (`contractVersion: 1`) with optional `inline` rules and registered `containers`; each container's `component` references a `contentComponents` key. Render inline rule names with `components["extension:<name>"]`. |
| `caret` | `CaretMode` | Show a streaming caret while blocks are still in-flight. |
| `statusMessage` | `string` | Optional host-coordinated milestone text rendered in one atomic polite status region. Omit it by default; update at coarse milestones, never per token. |
| `linkSafety` | `{ enabled?, onLinkCheck?, renderModal? }` | Intercept links and require confirmation before navigation. Rejected URLs never navigate. |
| `urlTransform` | `UrlTransform` | Custom URL transformation callback `(url, attribute, context) => string \| null \| undefined`. Defaults to `defaultUrlTransform` from `@stream-mdx/core`. |
| `deferHeavyBlocks` | `DeferHeavyBlocks` | Defer heavy blocks (e.g. Mermaid) until in view/idle. |
| `allowedElements` | `string[]` | Whitelist HTML tag names (mutually exclusive with `disallowedElements`). Filtered at render time across markdown and raw HTML. |
| `disallowedElements` | `string[]` | Tag names to disallow (mutually exclusive with `allowedElements`). Removed tags drop subtrees unless `unwrapDisallowed` is enabled. |
| `allowElement` | `(element, context) => boolean` | Custom element filter callback. Receives `{ tagName, properties, blockType? }` and `{ source: "markdown" | "html", parentTagName? }`. |
| `unwrapDisallowed` | `boolean` | When true, disallowed tags render their child content in place instead of dropping their entire subtree. Default `false`. |
| `disableAutolinkProtocols` | `string[]` | Protocols (e.g. `["mailto"]`, case-insensitive, trailing colon optional) whose autolinks render as plain text. Explicit markdown links `[label](url)` remain links. |
| `scheduling` | `StreamingSchedulerOptions` | Patch scheduler/backpressure knobs. |
| `onMetrics` | `(metrics: RendererMetrics) => void` | Invoked after each flush (queue depth, timings, adaptive budget state, worker metrics). |
| `onError` | `(error: Error) => void` | Render-time errors. Updating the callback does not restart the engine or discard streamed content. (Worker runtime errors surface via `error` events on the Worker.) |
| `className`, `style` | React props forwarded to the root container. |


Currency-safe math uses the same source-boundary rules before the parser admits a single-dollar span: opening/closing space, tab, or comma boundaries and a closing dollar immediately followed by a digit leave the span as text. A later unescaped `$` can close a skill-shaped token before any host skill-token presentation; for example, `$skillName$` is math when it satisfies those boundaries. Double-dollar display math always follows the math parser.
Table-row and table-cell presentations accept only `wrapper` and `props`; headless table customization goes through `components.table.view` with `useTableRows`.

`CodeEngine` has this contract:

```ts
import type { CodeTokenLine } from "stream-mdx/core";

interface CodeEngine {
  readonly id: string;
  tokenizeLines(request: {
    readonly language: string;
    readonly lines: readonly string[];
    readonly state: unknown | null;
  }): {
    readonly lines: readonly CodeTokenLine[];
    readonly state: unknown;
  };
}
```

The initial `state` is `null`; return the next state to pass to the next call for that code block. Return one token line per requested source line. Keep `id` stable for the same tokenizer. Changing it is a configuration change, like changing `themes` or `features`: the component starts a new renderer session with the new tokenizer. Source appended through the imperative handle is not carried into that session, so append it again.

`engines.code` runs in the main realm and is accepted only with `engine="main"`. Using it with `"auto"` or `"worker"` throws `EngineCompatibilityError`. For worker-realm tokenization, register the adapter in a custom worker with `serveMarkdownWorker({ extensions: { code } })`; worker functions are not passed through `engines.code`.
Notes:
- When `linkSafety.enabled` is on, the component replaces the `inline:link` presentation, including a supplied `components["inline:link"]`, with its confirmation-aware link renderer.
- Owned `text` renders initialize the complete document in one parse, then finalize the tail. Replacing text does not simulate chunked streaming. Rapid replacements match initialization acknowledgements in order; only the current source generation finalizes or reports a rejected initialization. Async iterators and imperative `append()` retain incremental parsing.
- Borrowed workers may be reused after detachment. Pending static calls reject on detach, but their initialization acknowledgement slots remain with the worker until drained; a later attachment cannot consume an older document's response as its own.

Type aliases:
- `type WorkerLike = Worker | URL | string | (() => Worker)`
- `type CaretMode = "block" | "circle" | string | false`
- `type DeferHeavyBlocks = boolean | { rootMargin?: string; idleTimeoutMs?: number; debounceMs?: number }`

### Execution modes and SSR

- `"worker"` requires browser `Worker` support and uses `worker` or the default worker strategy. It does not fall back to the main thread.
- `"main"` dynamically imports `@stream-mdx/worker/engine` and creates an in-process Worker adapter. It ignores `worker` and runs parsing on the browser thread.
- `"auto"` bootstraps up to 4,096 accepted UTF-16 source units with the existing inline engine on the main thread, without waiting for worker readiness or grammar prewarm. Further source is deferred beyond that limit. When auto hands off to the worker, the worker rebuilds the projection from the same canonical source. Node IDs, the stream generation, and accepted-source order do not change. Node, code and table handles are issued again once: views receive the new handles, and handles or saved presentation actions retained from before the handoff reject as stale.

Engine creation runs in a React effect, not during SSR. Selecting `"main"` does not compile server markup. For SSR/SSG, compile a snapshot with the Node/direct helper and render it with `@stream-mdx/react/server`. The default React import does not eagerly import the engine implementation. Applications still need a client boundary for `<StreamingMarkdown />`.
The retired `"main-thread"` value is a type error and throws a migration error at runtime; use `"main"`.

Changing `onError` uses the latest callback without restarting the engine or clearing streamed content. Worker protocol `ERROR` messages are distinct from browser Worker `error` events.

### Imperative Handle

```ts
type StreamingMarkdownHandle = {
  pause(): void;
  resume(): void;
  restart(): void;
  finalize(): Promise<FinalizeResult>;
  append(text: string): AppendResult;
  waitForCapacity(options: WaitForCapacityOptions): Promise<void>;
  setCredits(value: number): void;
  flushPending(): PatchFlushResult | null;
  waitForIdle(): Promise<void>;
  onFlush(listener: (result: PatchFlushResult) => void): () => void;
  getState(): RendererStateSnapshot;
  getPatchHistory(limit?: number): ReadonlyArray<RendererMetrics>;
};
```

export type AppendResult = {
  acceptedSourceUnits: number;
  pendingSourceUnits: number;
  shouldPause: boolean;
};

export type FinalizeResult = {
  generation: number;
  acceptedSourceUnits: number;
  committedSourceUnits: number;
};

The React entry point exports `AppendResult`, `FinalizeResult`, `WaitForCapacityOptions`, `SourceCapacityError`, and `StreamSessionError`.

- `append(text)` offers the whole imperative string atomically, measured in JavaScript UTF-16 code units. It returns cumulative `acceptedSourceUnits`, current `pendingSourceUnits`, and `shouldPause`. The soft threshold is 65,536 pending units and the hard limit is 262,144; refused offers accept no partial source. Session counts exclude `INIT.initialContent`.
- An imperative offer larger than the 262,144-unit hard limit rejects atomically with a non-retryable `SourceCapacityError`. Keep imperative offers at or below 65,536 units. If `shouldPause` is true, wait before offering the next piece: `await handle.waitForCapacity({ units: nextPiece.length, signal })`.
- Retry a refused offer only when it throws a retryable `SourceCapacityError`; wait for capacity for that exact offer, then retry it without reordering or dropping source. `waitForCapacity({ units, signal })` waits for room for the requested next offer. Requests larger than the hard limit reject with non-retryable `SourceCapacityError`; an offer refused only because capacity is currently occupied has a retryable `SourceCapacityError`. `StreamSessionError` reasons are `sealed`, `stale-generation`, and `disposed`. An aborted signal rejects the wait.
- Automatically owned `stream` adapters losslessly split iterator chunks larger than the imperative offer size before calling `append()`. They do not impose an arbitrary source-chunk cap or drop source.
- `finalize()` seals every host session synchronously, returns the same promise for repeated calls in that generation, and drains source accepted before the seal. It resolves to `FinalizeResult` (`{ generation, acceptedSourceUnits, committedSourceUnits }`) only after the matching native `FINALIZED` acknowledgement covers the accepted units and semantic patches have flushed into the renderer store.
- The `FinalizeResult` promise is a native semantic-store barrier, not a React DOM-commit or optional-enrichment barrier. It does not wait for trusted MDX projection, code highlighting/tokenization, decoration, or a React commit. Use the corresponding public store, scheduler, DOM, or enrichment observation when those are part of the caller's completion criteria.
- `waitForIdle()` resolves once the worker has admitted all source this session has accepted so far and the patch queue has committed it. It does not wait for a `stream` iterator to finish or for finalization; call `finalize()` when finalization is required. It rejects with `StreamSessionError` on a disposed or stale handle.
- After unmount, synchronous methods on a previously captured handle throw `StreamSessionError` with reason `disposed`; promise-returning methods reject with the same error.

Host handles seal regardless of `contentPolicy`; a reset or replacement opens the next host generation. This contract does not change raw `MarkdownEngine`, `MarkdownWorkerClient`, or worker-protocol controls. They remain lower-level APIs and do not provide the host admission ledger or `FinalizeResult` barrier.

`restart()` clears the renderer-owned document and cancels the current iterator generation. It does not rewind a single-use iterator, including after EOF. Supply a fresh iterator to `stream` to begin another stream; reiterable sources that return fresh iterators are supported. Each actual iterator is consumed at most once during the component's mounted lifetime, including renderer/readiness changes. A pending `next()` may settle before cancellation closes that iterator; cancelled chunks are discarded.

Removing an open stream releases that generation's activity. It does not end a replacement iterator or an independently open imperative session; call and await `finalize()` to close imperative activity.

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

`managedWorker={true}` requires `worker={existingWorker}` or a stable caller-accessible factory. Initialize that worker yourself with `INIT` and send document commands yourself or through the ref handle. Managed mode does not change lifecycle ownership: StreamMDX terminates factory-created workers on detach but never terminates a borrowed instance. Worker URL strings, URL objects, omitted/default workers, and `engine="main"` internal adapters are rejected in managed mode because the caller cannot initialize them through an accessible handle. Do not rely on an automatic engine fallback for managed workers.
Invalid managed sources and unavailable or failed worker creation report an error through `onError`; they do not silently create an inline engine.
Managed mode rejects `engine="main"` even when a Worker instance or factory is supplied. Use `engine="worker"` or `"auto"` with the caller-accessible worker source.

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
import { STREAM_MDX_SCHEMA_VERSION, type WorkerOut } from "@stream-mdx/core";

const messages: WorkerOut[] = [];
const engine = new MarkdownEngine({
  post: (message) => messages.push(message),
});

await engine.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, docPlugins: { math: false } });
await engine.handle({ type: "APPEND", text: "# Hello\n\nOne document." });
await engine.handle({ type: "FINALIZE" });
// A new INIT resets document state and retains this instance's extensions.
await engine.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "Another document." });
engine.dispose();
```

`handle(message: WorkerIn): Promise<void>` serializes protocol messages. Reset with `INIT`; there is no separate `reset()` or `emit()` method. `post(message: WorkerOut): void` sends through the supplied callback. `dispose(): void` releases instance state and stops further output. Disposal is terminal: afterwards `handle()` resolves immediately without processing the message, queued messages are skipped, and `post()` drops output. Create a new engine instead of reusing a disposed one.

Every live `PATCH` `WorkerOut` requires the root document `generation` that
matches its `INITIALIZED` source baseline. Reject mismatched messages before
queueing or committing them; do not infer a generation when delayed messages
arrive.

The constructor accepts `{ post, extensions?, extensionId? }`. `extensions` has `markdown?: MarkdownConfig[]`, `inline?: InlineExtension[]`, `documentPlugins?: DocumentPlugin[]`, `syntax?: SyntaxExtensionDescriptor`, and `code?: CodeEngine`. `extensionId` is caller-supplied and identifies the bundled extension set without hashing function source. Flags and HTML settings belong in `INIT`, not constructor options. Native extension functions cannot cross structured clone; bundle them into a custom worker entry with `serveMarkdownWorker({ extensions, extensionId })`, or create an adapter with `createInlineEngineWorker({ extensions, extensionId })` and supply it through a stable `worker={() => adapter}` factory in a Worker-capable browser. Do not pass the adapter directly as a Worker instance. The caller owns adapter termination. See [PLUGIN_ABI.md](./PLUGIN_ABI.md) for a complete custom entry.


---

## 3) Features

`features` toggles built-in capabilities in the worker + renderer:

- `tables`: GitHub-flavored markdown tables → table block snapshots (`components.table` controls presentation).
- `html`: enables inline/raw HTML (sanitized by default; `components["html:<tag>"]` controls presentation).
- `mdx`: recognizes component syntax. The default restricted policy renders only registered `contentComponents`; full MDX evaluation requires an explicit `TrustedMdxEngine` with `contentPolicy="trusted-mdx"`. A balanced JSX/MDX component whose native HTML block would be split by blank lines (for example `<SmokeBox>` … `</SmokeBox>`) stays one owning root and remains pending until it closes or the document finalizes.
- `math`: recognizes inline + display math (default delimiters: `$…$` and `$$…$$`).
- `footnotes`: enables footnote aggregation.
- `callouts`: enables callout blockquote syntax (disabled by default in the worker).
- `formatAnticipation`: (opt-in) withholds formatting markers while streaming (initial support: `*`, `**`, `` ` ``, `~~`). Final output is unchanged.
- `codeHighlighting`: controls Shiki strategy for fenced code blocks:
  - `"final"` (default): highlight only after the block finalizes.
  - `"incremental"`: highlight completed lines as they arrive (fast enough for streaming).
  - `"live"`: re-highlight on every update (slowest, highest fidelity).
- `themes`: optional `{ light: string | ThemeRegistration; dark: string | ThemeRegistration }` pair. Each side accepts a bundled theme name or a serializable Shiki theme registration object.
  - Used across all highlight strategies (static, incremental, live, lazy, diff).
  - Custom registrations are loaded into the worker's shared highlighter before resolving the selected pair.
  - Shared highlight cache identity includes both theme registrations and the selected regex engine.
  - Invalid or unknown themes report an INIT error and fall back to the default GitHub themes for the invalid side.
- `highlightEngine`: optional `"javascript"` (default) or `"oniguruma"`. Oniguruma uses the WASM engine; select it when JavaScript regex execution is unsuitable.

### Context support table

| Feature | Browser worker streaming | Node snapshot compile | Edge/no-worker compile |
| --- | --- | --- | --- |
| `tables` | Yes | Yes | Preview |
| `html` | Yes (sanitized) | Yes (sanitized) | Preview |
| `math` | Yes | Yes | Preview |
| `mdx` | Restricted source by default; full MDX requires an explicit `TrustedMdxEngine` in the browser React integration. | Snapshot parsing does not automatically evaluate MDX. | Snapshot parsing does not automatically evaluate MDX. |
| `footnotes` | Yes | Yes | Preview |
| `callouts` | Yes | Yes | Preview |
| Code themes (`themes`) | Yes | Yes | Preview |
| Mermaid addon (`@stream-mdx/mermaid`) | Yes (renderer component) | Yes (renderer component) | Preview (renderer component) |
| Unified adapter (`@stream-mdx/unified`) | Yes (returns `NodePresentations` for `components`) | Yes (returns `NodePresentations` for `components`) | Yes (returns `NodePresentations` for `components`) |

---

## 3.1) Mermaid (optional)

Mermaid diagrams are provided as an **opt-in addon** via `@stream-mdx/mermaid`.

```bash
npm install @stream-mdx/mermaid
```

```tsx
import { createMermaidEngine } from "@stream-mdx/mermaid";
import { StreamingMarkdown } from "@stream-mdx/react";

const mermaidEngine = createMermaidEngine({
  config: { theme: "neutral" },
});

<StreamingMarkdown
  text={"```mermaid\nflowchart TD\n  A --> B\n```"}
  engines={{ mermaid: mermaidEngine }}
/>;
```

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
## 3.2) Code Presentations

`components.code.wrapper` receives the current block, its language metadata, native code children, and actions. Return those children for languages you do not customize:

```tsx
import { StreamingMarkdown, type NodeViewProps } from "@stream-mdx/react";

function CodePresentation({ children, metadata }: NodeViewProps) {
  if (metadata.language?.toLowerCase() !== "chart") return children;
  return <section><p>Language: {metadata.language}</p>{children}</section>;
}

export function CodeExample({ text }: { text: string }) {
  return <StreamingMarkdown text={text} components={{ code: { wrapper: CodePresentation } }} />;
}
```

Native code views keep their highlighting, streaming updates, virtualization, and controls. A wrapper should preserve the provided `children` except when it intentionally renders a specialized presentation.

Language matching is case-insensitive (e.g. `JS` resolves to the `js` renderer). A key that misses falls back to the canonical grammar name, so a renderer registered as `javascript` also receives ```` ```js ```` fences. `defer: true` opts that renderer into viewport/idle deferral when `deferHeavyBlocks` is enabled.

`language` is the authored first info word, exactly as written (```` ```js ```` gives `"js"`), matching the CommonMark `language-js` class. Aliases such as `js`, `ts`, `py` and `sh` only choose the Shiki grammar.

```ts
import type React from "react";

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

`renderCode` is an already rendered React node, not a function. Return it directly when your custom view is unavailable. Explicit language renderers take precedence over built-in diff rendering and `components.code`.

With `features.emitDiffBlocks: true`, fences with diff metadata use `DefaultDiffRenderer`, including line numbers and token colors. Without diff metadata it returns `renderCode`. A custom language renderer overrides that view.


### Headless diff code views

A headless code presentation can read diff state and prepared rows without reparsing Markdown:

```tsx
import type { CodeNodeHandle } from "@stream-mdx/core";
import { StreamingMarkdown, useCodeDiff } from "@stream-mdx/react";

function DiffView({ handle }: { handle: CodeNodeHandle }) {
  const { diffStatus, lines } = useCodeDiff(handle, { from: 0, to: 100 });
  return (
    <section data-diff-status={diffStatus}>
      {lines.map((line) => (
        <div
          key={line.id}
          data-kind={line.diffKind}
          data-old-no={line.oldNo}
          data-new-no={line.newNo}
          data-exactness={line.decoration?.exactness}
        >
          {line.text}
        </div>
      ))}
    </section>
  );
}

<StreamingMarkdown components={{ code: { view: DiffView } }} />;
```

The `{ from, to }` range is half-open and zero-based; choose the rows the view needs rather than reading the whole code block. `diffStatus` is `complete`, `incomplete`, or `malformed` for diff fences, and each `CodeLineRecord` retains its `diffKind`, `oldNo`, `newNo`, and current token-decoration exactness.

### Headless table views

A headless table presentation can read stable column metadata and a bounded range of prepared body rows:

```tsx
import type { TableNodeHandle, TableRowRange } from "@stream-mdx/core";
import { StreamingMarkdown, useTableBlock, useTableRows } from "@stream-mdx/react";

const FIRST_ROWS: TableRowRange = { from: 0, to: 20 };

function TableView({ handle }: { handle: TableNodeHandle }) {
  const table = useTableBlock(handle);
  const rows = useTableRows(handle, FIRST_ROWS);
  return (
    <table>
      <thead>
        <tr>{table.header.cells.map((cell) => <th key={cell.id}>{cell.raw}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>{row.cells.map((cell) => <td key={cell.id}>{cell.raw}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

<StreamingMarkdown features={{ tables: true }} components={{ table: { view: TableView } }} />;
```

`useTableRows` takes a zero-based half-open `{ from, to }` range. `useTableBlock` exposes current table metadata and its stable header; row consumers are notified only when records in their requested range change.

### Explicit preview slots

`PreviewSlot` is an ordinary node view, not a renderer option or an execution feature. A registered view can keep the prepared native node as an inert fallback:

```tsx
import type { CodeNodeHandle } from "@stream-mdx/core";
import { NativeNodeView, PreviewSlot, StreamingMarkdown } from "@stream-mdx/react";

function CodePreview({ handle }: { handle: CodeNodeHandle }) {
  return (
    <PreviewSlot handle={handle}>
      <NativeNodeView handle={handle} />
    </PreviewSlot>
  );
}

<StreamingMarkdown components={{ code: { view: CodePreview } }} />;
```

Without a runtime, the slot wraps `children` in `data-stream-mdx-preview-slot` with `data-preview-runtime="none"`; it does not execute or interpret the source. A host can pass an explicit `PreviewRuntime` to render its `view`, which receives the `NodeRevisionFeed`, current `NodeRevisionSnapshot`, and native `fallback`.

`useNodeRevisionFeed(handle)` returns `{ feed, snapshot }`. Snapshots are frozen and keep their identity until `revision` or `isFinalized` changes. `feed.readSource()` is an explicit cold read, not part of subscription or rendering. Code handles use their generation-bound source reader; other node handles use the presentation's store-backed source. Reads from an obsolete generation throw the existing stale-handle error. This API provides neither a compiler nor a sandbox: hosts remain responsible for authorizing and isolating any runtime they install.

### Artifact-like code fences

Fences labeled `artifact` or `html-artifact` render as ordinary code unless a `components.code.wrapper` explicitly routes them elsewhere. StreamMDX does not ship a default artifact iframe or sandbox. A custom presentation is application code; if it turns source into active content, the host owns its isolation and security policy.


Math uses KaTeX by default. To replace TeX rendering, provide `engines.math`, whose synchronous `render(tex, { displayMode })` method returns React output and has a stable `id`. Both inline and display math use `components["inline:math"]` to wrap or view that engine output; this presentation does not perform a second TeX render. `features.math: false` disables math recognition, including inside opt-in HTML markdown.

### Syntax extensions and HTML

`syntax` accepts `SyntaxExtensionDescriptor` from `@stream-mdx/core`: `contractVersion` is `1`, `inline` contains `SyntaxRuleSpec` rules, and `containers` contains `{ name, component }` registrations. Each `component` must name an entry in `contentComponents`. Inline rules emit `"plugin"` inline nodes with a name, string attributes, optional parsed children, and raw matched text. Map plugin names with `components["extension:<name>"]` views receiving `InlineNodeViewProps` (`node`, prepared `children`, metadata, and actions). Standard inline keys include `"inline:text"`, `"inline:strong"`, `"inline:em"`, `"inline:code"`, `"inline:link"`, and `"inline:image"`. See [PLUGIN_ABI.md](./PLUGIN_ABI.md) for capture, lookahead, anticipation, and invalid-`INIT` behavior.

A registered opener uses at least three colons followed by its name. It is recognized at a block start or after a paragraph-separating blank line; code and escaped source keep precedence. A bare closer closes only the innermost container when its colon count exactly matches the opener. Unmatched closers remain literal source. `FINALIZE` marks unclosed containers `incomplete` and supplies the diagnostic `Unclosed container :::<name>`.

`HtmlOptions` is `{ allowedTags?: Record<string, string[]>; literalTagContent?: string[] }`. `allowedTags` adds permitted tags and replaces their tag-specific attribute lists while retaining global schema attributes. URL protocol checks still apply to `href`/`src`/`action`/`formaction`/`xlink:href`; `script`/`style` tags remain excluded. `on*` event handler attributes and `srcdoc` are strictly forbidden and always stripped regardless of `allowedTags`. Raw HTML `style` attributes are sanitized using DOM-free safe property allowlists. Custom allowlists are trusted application policy. `components["html:<tag>"]` decorates permitted tags; headless views receive sanitized attributes and typed children.
Raw HTML block content is literal by default. Supplying `literalTagContent`, even `[]`, opts into engine-owned inline markdown parsing inside eligible HTML children. `code`, `pre`, and `textarea`, plus listed tags, stay literal. Inline syntax plugins and the engine's math flag apply to opt-in children; mapped components do not reparse strings. HTML must also be enabled via `features.html`.
Restricted `contentComponents` can be decorated with `props` and wrapped by `components["component:<registrationName>"]`. This key rejects headless `view` entries when the presentation registry is configured because restricted components do not expose the native `NodeHandle` contract; use a rich wrapper when replacing their presentation.


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

- **Code blocks**: The Copy button writes the full authored source. Native text selection inside a code viewport copies only that exact authored range, preserving its line endings. Download saves the complete source as `snippet.<ext>` (e.g. `.ts`, `.py`, `.rs`, `.sql`) with its original line endings and trailing newline. Both actions work with virtualized code.
- **Tables**: Copy as TSV (ready to paste into spreadsheets) or Markdown. Download as CSV, TSV, or Markdown with strict RFC 4180 escaping (quotes, commas, newlines). Table controls become active when the native table closes, even if the surrounding document stream continues. Built-in managed-table controls read row text only when copied or downloaded.
- **Managed custom table controls**: `ControlsComponentProps` supplies `headers`, `align`, and `getTableData()`. It intentionally omits the full `rows` array so rendering does not materialize the table prefix; call `getTableData()` inside a user action when complete row strings are needed. `onCopy` and `onDownload` retain the built-in action behavior.
- **Mermaid / Code Fences**: Exposed through `CodeFenceRendererProps` (`controls` flags and `copy()` helper). `MermaidBlock` opts in to source diagram code copying in its toolbar and code view.
- **Accessibility & SSR**: Buttons are real `<button type="button">` with `aria-label`, `data-stream-mdx-control`, and semantic classes. Both `StreamingMarkdown` and `MarkdownBlocksRenderer` omit live regions by default; `statusMessage` enables one atomic polite region for host-coordinated milestones. Rendering is 100% SSR-safe (no `window` access during render).
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
  return <StreamingMarkdown text={markdown} components={unifiedRenderer} />;
}
```
Explicit `blockTypes` replaces the default routing list. Routed lists and blockquotes replace native container children, including prepared nested snapshots, with the unified result. Exclude those containers to retain native code, math, HTML, and syntax components inside them. A successful unified presentation replaces that block's native rendering.


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
- Only mounted, finalized tables at or above `minRows` virtualize, and only when the surrounding streaming session is inactive. A completed table followed by an unfinished paragraph stays fully rendered. Imperative `append()` opens a session; `await finalize()` closes and seals it when no async iterator is active. Normal iterator EOF also awaits finalization before closing its activity. After EOF or explicit finalization, call `restart()` or replace the owned source to begin a new generation before appending again. Removing a stream prop does not itself reopen a sealed generation.
- Replacing `text`, replacing an iterator, or calling `restart()` clears the renderer-owned engine document using its existing initialization options. Old iterator generations cannot finalize the replacement session. With `managedWorker`, the caller owns engine initialization: restart clears the renderer store without sending `INIT` or discarding the caller's engine document.
- The scroll container has a native sticky `<thead>` and an accessible name. Spacer rows are `aria-hidden`. Only mounted body rows appear in the accessibility tree; disable virtualization when every row must be available to assistive technology, browser find, or printing.
- The initial full table uses native automatic column sizing. Measured column widths then populate an explicit `<colgroup>` while rows are windowed. Container width changes trigger another full-table natural-layout pass and invalidate cached row heights. A `ResizeObserver` measures mounted multiline rows and later content resizes.
- Disabling virtualization or replacing its native table/header invalidates natural column widths and every cached row height. Re-enabling measures the complete current table even at unchanged viewport width. Adapter replacement rebinds observers to the current native table, header, and mounted rows; detached-node callbacks cannot update the new measurement generation.
- Row keys and `data-row-id` values stay stable as the window changes. Spacer heights account for omitted rows. Scrolling to the bottom mounts the final row.
- Custom `components.table.wrapper` presentations wrap the native table viewport. The renderer keeps its native rows, sections, cells, and spacers; wrappers between the table and owned viewport may have overflow normalized to preserve virtualization. Original overflow shorthand/longhand declarations and priorities are restored on disable/unmount. Unrelated inline styles remain untouched.
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
## 3.7) Math Rendering (`engines.math`)
StreamMDX includes first-party KaTeX rendering by default for inline (`$...$`) and display (`$$...$$`) math. Set `engines.math` to replace only the renderer while preserving parsing:

```tsx
import type { MathEngine } from "stream-mdx";

const mathEngine: MathEngine = {
  id: "mathjax",
  render: (tex, { displayMode }) => <MathJaxFormula tex={tex} display={displayMode} />,
};

<StreamingMarkdown engines={{ math: mathEngine }} />;
```

`MathEngine.render` runs synchronously on the main thread and must be safe during server rendering. A presentation at `components["inline:math"]` receives engine output as its children for both inline and display math; it owns only the view or wrapper and does not render TeX a second time. Omitting `engines.math` keeps KaTeX.
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

## 4) MDX

`contentPolicy` defaults to `"restricted"`. Register approved source names using `defineContentComponent`; raw constructors are not registrations. A type-predicate validator is required for narrower source JSON props, and native projected `children` are supplied separately as host React nodes. `contentComponents` is active only under `"restricted"` policy, not `"markdown"` or `"trusted-mdx"`.

For trusted, reviewed full MDX, create an explicit engine from `@stream-mdx/react/trusted-mdx` and pass it through `engines.mdx`:

```tsx
import { StreamingMarkdown } from "stream-mdx";
import { createTrustedMdxEngine } from "@stream-mdx/react/trusted-mdx";
import { Callout } from "./Callout";

const hostWidgets = { Callout };
const mdxEngine = createTrustedMdxEngine({
  components: hostWidgets,
  imports: { "host:widgets": hostWidgets },
});

<StreamingMarkdown
  text={text}
  features={{ mdx: true }}
  contentPolicy="trusted-mdx"
  engines={{ mdx: mdxEngine }}
/>;
```


The import map is the host's capability grant for authored module specifiers; unresolved imports fail instead of being fetched. Trusted evaluation runs in the host realm, requires `unsafe-eval` in `script-src`, and is not a sandbox. Use it only for trusted, reviewed source. Native worker `FINALIZED` confirms semantic completion only; trusted projection and actual React commit readiness are separate and asynchronous. See the [React Integration Guide](./REACT_INTEGRATION_GUIDE.md) and [Security Model](./SECURITY_MODEL.md) for the lease lifecycle and safety requirements.

### Next.js App Router (server-safe rendering)

```tsx
import { MarkdownBlocksRenderer, ComponentRegistry } from "@stream-mdx/react/server";
import { compileMarkdownSnapshot } from "stream-mdx/worker/node";

export default async function Page() {
  const { blocks } = await compileMarkdownSnapshot({
    text: "# Hello\\n\\nStreaming-safe server render.",
    init: {
      docPlugins: { tables: true, html: true, mdx: true, math: true, footnotes: true },
      prewarmLangs: ["typescript"],
    },
  });

  return <MarkdownBlocksRenderer blocks={blocks} componentRegistry={new ComponentRegistry()} />;
}
```


If an RSC constructs restricted registrations, import the pure `defineContentComponent` factory from `@stream-mdx/react/server`, not the client root.

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

### Extension-aware snapshots and synchronous remounts

`createMarkdownSnapshotCompiler({ extensions, extensionId })` compiles through the canonical parser in-process. For a host-bundled worker, pass that worker as `worker`; it must have been created with the same extension set and `extensionId`. Calls are serialized and `maxQueueSize` (default `32`) bounds active plus waiting compiles. The caller-supplied ID participates in snapshot cache identity; extension function source is never inspected or hashed.

```tsx
import { MarkdownBlocksRenderer } from "@stream-mdx/react/server";
import { createMarkdownSnapshotCompiler } from "stream-mdx/worker/direct";

const compiler = createMarkdownSnapshotCompiler({ extensions, extensionId: "km-markdown-v3" });
const { blocks } = await compiler.compile({ text: finalizedMarkdown });

// Store this array alongside the finalized message, then pass it to a client row:
<MarkdownBlocksRenderer blocks={blocks} components={presentations} />;
```

The same `MarkdownBlocksRenderer` and `components`/`NodePresentations` work in client rendering as well as SSR; the renderer does not need to compile or initialize a worker when mounting cached blocks.

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
