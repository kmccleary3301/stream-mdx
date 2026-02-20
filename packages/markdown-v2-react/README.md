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

## Bottom-stick scroll area (packaged)

`@stream-mdx/react` now exports a reusable bottom-stick scroll container for streaming/chat surfaces:

```tsx
import { BottomStickScrollArea } from "@stream-mdx/react";
```

Behavior:

- sticky-at-bottom while content appends (`STICKY_INSTANT`)
- detach on upward user scroll (`DETACHED`)
- smooth return-to-bottom with cancel-on-user-scroll (`RETURNING_SMOOTH`)

This component includes debug hooks (`onDebugStateChange`) and DOM debug attributes (`debugDomAttributes`) used by deterministic checks.

## ShadCN-style drop-in file

For copy/paste distribution (single file), use:

- `shadcn/bottom-stick-scroll-area.tsx`

This is intentionally source-first and meant to be placed directly in app repos (same workflow as ShadCN component files).
