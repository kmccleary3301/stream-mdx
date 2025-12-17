# `@stream-mdx/react`

React renderer for StreamMDX. Exposes the `<StreamingMarkdown />` component, scheduling/backpressure hooks, and the public types used by consumers.

Most apps should install `stream-mdx` instead of this package directly. Use `@stream-mdx/react` when you want the React surface without the unscoped wrapper.

## Install

```bash
npm install @stream-mdx/react @stream-mdx/worker
```

`react` and `react-dom` are peer dependencies.

## Quickstart

Copy the hosted worker bundle into your app’s static assets:

```bash
mkdir -p public/workers
cp node_modules/@stream-mdx/worker/dist/hosted/markdown-worker.js public/workers/markdown-worker.js
```

Render streaming markdown from a client component:

```tsx
"use client";

import { StreamingMarkdown } from "@stream-mdx/react";

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

## Docs

- API reference: `docs/PUBLIC_API.md`
- React integration guide: `docs/REACT_INTEGRATION_GUIDE.md`
- Plugins & worker customization: `docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`
