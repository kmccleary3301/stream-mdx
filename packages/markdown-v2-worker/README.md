# `@stream-mdx/worker`

`@stream-mdx/worker` contains the worker runtime surface for StreamMDX: hosted worker assets, worker client helpers, Node `worker_threads` helpers, direct compile helpers, and MDX compile parity utilities.

Most browser app consumers will touch this package only indirectly through [`stream-mdx`](../stream-mdx/README.md) or [`@stream-mdx/react`](../markdown-v2-react/README.md). Use it directly when you need explicit worker/runtime control.

## Install

```bash
npm install @stream-mdx/worker
```

## Exports

| Export | Purpose |
| --- | --- |
| `@stream-mdx/worker` | Main worker utilities surface |
| `@stream-mdx/worker/engine` | `MarkdownEngine`, `serveMarkdownWorker`, `createInlineEngineWorker`, and extension types |
| `@stream-mdx/worker/worker-client` | Explicit worker client wiring |
| `@stream-mdx/worker/node` | Node `worker_threads` hosted-worker helper |
| `@stream-mdx/worker/direct` | Direct compile path without `worker_threads` |
| `@stream-mdx/worker/mdx-compile` | Shared MDX compile helper |
| `@stream-mdx/worker/hosted/markdown-worker.js` | Hosted worker bundle asset |

## Hosted Worker Bundle

Recommended production flow:

```bash
mkdir -p public/workers
cp node_modules/@stream-mdx/worker/dist/hosted/markdown-worker.js public/workers/markdown-worker.js
```

Then point the React surface at it:

```tsx
<StreamingMarkdown worker="/workers/markdown-worker.js" />
```

This is the preferred deployment path for explicit CSP control and predictable static hosting.

`<StreamingMarkdown engine="auto" />` defaults to a browser Worker, then dynamically imports an in-process engine if Worker construction is unavailable or fails. `engine="worker"` requires a Worker; `engine="main-thread"` skips it and runs parsing on the browser thread. These modes initialize in a React effect, not during SSR. They do not recover from later worker script loading or runtime errors.

## Isolated engine and custom entries

```ts
import { MarkdownEngine } from "@stream-mdx/worker/engine";
import type { WorkerOut } from "@stream-mdx/core";

const messages: WorkerOut[] = [];
const engine = new MarkdownEngine({ post: (message) => messages.push(message) });
await engine.handle({ type: "INIT" });
await engine.handle({ type: "APPEND", text: "# Hello" });
await engine.handle({ type: "FINALIZE" });
await engine.handle({ type: "INIT", initialContent: "A new document" });
engine.dispose();
```

Each engine owns document state and emits protocol messages through `post`. A new `INIT` resets the document while retaining instance extensions. Constructor options are `{ post, extensions? }`; flags and HTML settings belong in `INIT`.

Bundle native functions with `serveMarkdownWorker({ extensions })`. For in-process use, `createInlineEngineWorker({ extensions })` returns a Worker-compatible adapter with microtask delivery and `terminate()`. Extensions accept `markdown`, `inline`, `documentPlugins`, and serializable `syntax` arrays. See the [complete custom worker entry](../../docs/PLUGIN_ABI.md#3-custom-bundled-worker-entry). The published engine entry is pre-built for the worker realm with DOM-free MDX dependencies, so browser-targeted bundlers (the documented esbuild `--platform=browser` command) produce a worker that boots without `document`/`DOMParser` shims, aliases, or extra configuration.

## Node `worker_threads` Helper

```ts
import { compileMarkdownSnapshot } from "@stream-mdx/worker/node";

const result = await compileMarkdownSnapshot({
  text: "# Hello\n\nCompiled in Node worker_threads.",
  init: {
    docPlugins: { tables: true, html: true, math: true, mdx: true, footnotes: true },
  },
});
```

Use this for SSR, static export, offline compilation, or TUI/CLI pipelines that want the same hosted worker behavior outside the browser.

## Direct Compile Helper

```ts
import { compileMarkdownSnapshotDirect } from "@stream-mdx/worker/direct";

const result = await compileMarkdownSnapshotDirect({
  text: "# Hello\n\nDirect compile without worker_threads.",
  init: {
    docPlugins: { tables: true, html: true, math: true, mdx: true, footnotes: true },
  },
});
```

Use this in runtimes where `worker_threads` are unavailable or undesirable.

## MDX Compile Parity Helper

```ts
import { compileMdxContent } from "@stream-mdx/worker/mdx-compile";
```

This is the shared MDX compilation path used to keep browser-worker and server compile flows aligned.

## When To Reach For This Package

| Need | Use this package? |
| --- | --- |
| Host a static worker bundle in production | Yes |
| Compile markdown snapshots in Node | Yes |
| Build a custom worker integration | Yes |
| Standard React app usage only | Usually no; use `stream-mdx` |

## Documentation

- [`../../docs/CLI_USAGE.md`](../../docs/CLI_USAGE.md)
- [`../../docs/REACT_INTEGRATION_GUIDE.md`](../../docs/REACT_INTEGRATION_GUIDE.md)
- [`../../docs/SECURITY_MODEL.md`](../../docs/SECURITY_MODEL.md)
- [`../../docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`](../../docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md)
