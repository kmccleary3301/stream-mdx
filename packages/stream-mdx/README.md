# `stream-mdx`

High-performance streaming Markdown/MDX renderer for React with a worker-first pipeline, incremental patching, and backpressure guardrails.

This is the **convenience** package:

- `stream-mdx` re-exports the main React API from `@stream-mdx/react`
- `stream-mdx/{core,react,worker,plugins}` proxy to the scoped packages
- `stream-mdx/plugins/*` proxies the common plugin entrypoints (helpful for pnpm users)

If you want maximum modularity (or you’re publishing your own library), install the scoped packages directly. Otherwise, start here.

## Install

```bash
npm install stream-mdx
```

## Quickstart

### 1) Copy the hosted worker bundle

In production you should host the worker bundle from static assets (stricter CSP, no `blob:`).

After installing, copy the worker into your app:

```bash
mkdir -p public/workers
cp node_modules/@stream-mdx/worker/dist/hosted/markdown-worker.js public/workers/markdown-worker.js
```

### Next.js (App Router)

`StreamingMarkdown` is a **client component**. Import it behind a `"use client"` boundary.

```tsx
"use client";

import { StreamingMarkdown } from "stream-mdx";

export function Demo({ text }: { text: string }) {
  return (
    <StreamingMarkdown
      text={text}
      worker="/workers/markdown-worker.js"
      features={{ html: true, tables: true, math: true, mdx: true }}
      mdxCompileMode="worker"
    />
  );
}
```

If you import `StreamingMarkdown` from a server component, you’ll typically see `useRef is not a function`. Fix by moving the import behind a `"use client"` boundary.

### Vite React

```tsx
import { StreamingMarkdown } from "stream-mdx";

export default function App() {
  return (
    <StreamingMarkdown
      text="## Hello\n\nStreaming **markdown**"
      worker="/workers/markdown-worker.js"
      features={{ html: true, tables: true, math: true }}
    />
  );
}
```

## Configuration at a glance

- `text` / `stream`: provide a full string or an append-only `AsyncIterable<string>`.
- `worker`: a `Worker`, `URL`, URL string, or factory; defaults to the built-in worker strategy and falls back to `/workers/markdown-worker.js`.
- `features`: `{ html?, tables?, mdx?, math?, footnotes?, callouts? }`.
- `mdxCompileMode`: `"worker"` (no server) or `"server"` (requires an endpoint; see docs).
- `components` / `inlineComponents`: override block + inline renders (wrap code/math without losing incremental rendering).
- `tableElements`: override table tags (e.g. Shadcn table wrappers).
- `htmlElements`: override HTML tag renders (when HTML is enabled).
- `mdxComponents`: MDX component registry (when MDX compilation is enabled).
- `scheduling`: patch scheduler/backpressure knobs.

## Plugins

Common entrypoints (convenience package):

- `stream-mdx/plugins/document`
- `stream-mdx/plugins/tables`
- `stream-mdx/plugins/html`
- `stream-mdx/plugins/math`
- `stream-mdx/plugins/mdx`

Scoped equivalents:

- `@stream-mdx/plugins/document` (etc)

## Docs

- Docs site: https://kmccleary3301.github.io/stream-mdx/
- Manual: `docs/COMPREHENSIVE_PROJECT_DOCUMENTATION.md`
- API: `docs/PUBLIC_API.md`
- React integration: `docs/REACT_INTEGRATION_GUIDE.md`
- Plugins cookbook: `docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`
- Status/architecture notes: `docs/STREAMING_MARKDOWN_V2_STATUS.md`
- Release checklist: `docs/STREAMING_MARKDOWN_RELEASE_CHECKLIST.md`

## Package map

- `stream-mdx` – React surface (`@stream-mdx/react`)
- `stream-mdx/react` – React renderer + types
- `stream-mdx/worker` – worker client + default worker helpers
- `stream-mdx/plugins` – plugin registry + helpers
- `stream-mdx/plugins/*` – common plugin entrypoints
- `stream-mdx/core` – structured-clone-safe types + perf utilities
