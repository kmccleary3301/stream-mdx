# `@stream-mdx/worker`

Web Worker entry point for the streaming renderer. Handles markdown parsing (Lezer), inline enrichment, Shiki highlighting, MDX detection, and patch emission. Consumers rarely interact with this package directly unless they need explicit control over worker instantiation or CSP compliance.

## Install

```bash
npm install @stream-mdx/worker
```

## Usage

```ts
import { MarkdownWorkerClient } from "@stream-mdx/worker";

const client = new MarkdownWorkerClient({
  // For CSP-restricted environments, host the worker and point to it here:
  workerUrl: "/workers/markdown-worker.js",
});

client.onMessage((msg) => {
  if (msg.type === "PATCH") {
    // apply patches
  }
});

client.init("# Hello");
```

`MarkdownWorkerClient` will try `createDefaultWorker()` first (Blob/inline), then fall back to a hosted worker URL (`/workers/markdown-worker.js` by default).

> Keep `docPlugins` in sync with the renderer when enabling math+MDX. Follow the [cookbook recipe](../../docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md#5-math--mdx-workerrenderer-registration); the worker and React packages now ship tests enforcing it.

## Message unions

| Type | Direction | Payload |
| --- | --- | --- |
| `INIT` | Main → Worker | `{ text?: string; stream?: boolean; prewarmLangs?: string[]; plugins?: PluginConfig }` |
| `APPEND` | Main → Worker | `{ chunk: string }` |
| `FINALIZE` | Main → Worker | Flush + emit remaining patches. |
| `RESET` | Main → Worker | Clear state (used on restart). |
| `PATCH` | Worker → Main | `{ tx, at, patches: Patch[], notes }` |
| `METRICS` | Worker → Main | Parse/highlight timings, block stats. |
| `INITIALIZED`, `ERROR`, `DEBUG` | Worker → Main | Lifecycle events. |

Exact shapes live in `@stream-mdx/core` (`WorkerMessageIn`, `WorkerMessageOut`).

## Hosting guidance

- **Blob (default):** easiest for local dev, but CSP must allow `blob:` execution.
- **Hosted URL:** build the hosted worker bundle and copy it into your app’s static assets (e.g. `public/workers/markdown-worker.js`).
- **Build hosted worker:** from the repo root, run `npm run worker:build`.

For CSP-restricted environments, prehost the worker and set `Cross-Origin-Embedder-Policy` / `Cross-Origin-Opener-Policy` headers if you rely on SharedArrayBuffers.

## Troubleshooting

- **`setStreamLimit` missing** – ensure you updated the demo automation shim; the worker no longer exports legacy control messages.
- **Import errors in worker bundle** – verify your bundler targets `type: "module"` workers and preserves ESM syntax. When in doubt, use the prebuilt `public/workers/markdown-worker.js`.
- **MDX compilation issues** – match the worker’s plugin registry with the React side, and confirm you set `mdxCompileMode="worker"` if you expect in-worker compilation.
