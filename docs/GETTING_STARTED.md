# Getting Started

## Install

```bash
npm install stream-mdx
```

## Host the worker bundle

In production, host the worker bundle from static assets (avoid `blob:` CSP requirements):

```bash
mkdir -p public/workers
cp node_modules/@stream-mdx/worker/dist/hosted/markdown-worker.js public/workers/markdown-worker.js
```

## Render Markdown (CLI / Node)

If you want to reuse the worker + patch stream in a terminal UI (Ink, etc.), use the Node worker helper:

- `stream-mdx/worker/node` (or `@stream-mdx/worker/node`)

See `docs/CLI_USAGE.md` for a complete example that consumes `PATCH` messages into a `DocumentSnapshot`.

## Render Markdown (React)

### Next.js (App Router)

`StreamingMarkdown` is a client component.

```tsx
"use client";

import { StreamingMarkdown } from "stream-mdx";

export function Demo({ text }: { text: string }) {
  return <StreamingMarkdown text={text} worker="/workers/markdown-worker.js" />;
}
```

### Vite React

```tsx
import { StreamingMarkdown } from "stream-mdx";

export default function App() {
  return <StreamingMarkdown text="## Hello\n\nStreaming **markdown**" worker="/workers/markdown-worker.js" />;
}
```

## Next steps

- Props/types: `docs/PUBLIC_API.md`
- MDX + customization: `docs/REACT_INTEGRATION_GUIDE.md`
- Plugin/worker cookbook: `docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`
