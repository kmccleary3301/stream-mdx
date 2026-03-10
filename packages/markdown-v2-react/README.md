# `@stream-mdx/react`

`@stream-mdx/react` is the renderer package for StreamMDX. It owns the React component surface, the renderer store, patch scheduling, server rendering helpers, and the packaged bottom-stick scroll component used by the docs/demo surfaces.

**Most apps should install [`stream-mdx`](../stream-mdx/README.md) instead.** Use this package directly when you want the React layer without the convenience wrapper.

## Install

```bash
npm install @stream-mdx/react @stream-mdx/worker
```

Peer dependencies:

| Package | Range |
| --- | --- |
| `react` | `>=18.2.0` |
| `react-dom` | `>=18.2.0` |

## Primary Exports

| Export | Purpose |
| --- | --- |
| `@stream-mdx/react` | Main React surface including `<StreamingMarkdown />` |
| `@stream-mdx/react/server` | Server/static render helpers |
| `@stream-mdx/react/components` | Shared UI component exports |
| `@stream-mdx/react/components/bottom-stick-scroll-area` | Packaged sticky-bottom scroll container |
| `@stream-mdx/react/renderer` | Lower-level renderer exports |
| `@stream-mdx/react/renderer/patch-commit-scheduler` | Scheduler implementation surface |
| `@stream-mdx/react/renderer/store` | Renderer store surface |
| `@stream-mdx/react/mdx-client` | MDX client helpers |
| `@stream-mdx/react/mdx-coordinator` | MDX coordination helpers |

## Quickstart

```bash
mkdir -p public/workers
cp node_modules/@stream-mdx/worker/dist/hosted/markdown-worker.js public/workers/markdown-worker.js
```

```tsx
"use client";

import { StreamingMarkdown } from "@stream-mdx/react";

export function Demo({ text }: { text: string }) {
  return (
    <StreamingMarkdown
      text={text}
      worker="/workers/markdown-worker.js"
      features={{ html: true, tables: true, math: true, mdx: true, footnotes: true }}
      mdxCompileMode="worker"
    />
  );
}
```

## Typical Uses

| Use case | API |
| --- | --- |
| Browser/client rendering | `<StreamingMarkdown />` |
| SSR / SSG / static export rendering | `MarkdownBlocksRenderer` from `@stream-mdx/react/server` |
| Rich streaming/chat container | `BottomStickScrollArea` |
| Advanced renderer internals | `renderer/store`, `renderer/patch-commit-scheduler` |

### Server-side block rendering

```tsx
import { ComponentRegistry, MarkdownBlocksRenderer } from "@stream-mdx/react/server";

return <MarkdownBlocksRenderer blocks={blocks} componentRegistry={new ComponentRegistry()} />;
```

### Bottom-stick scroll area

```tsx
import { BottomStickScrollArea } from "@stream-mdx/react/components/bottom-stick-scroll-area";

<BottomStickScrollArea className="h-[32rem]">{children}</BottomStickScrollArea>;
```

Behavior notes:

- sticks to bottom while content appends
- detaches on upward user scroll
- supports smooth return-to-bottom behavior
- exposes debug hooks used by deterministic checks in the repo

## When To Use This Package Directly

- You are shipping a library that wants `@stream-mdx/react` explicitly in `peerDependencies` or `dependencies`.
- You need server rendering helpers without the convenience wrapper import path.
- You are working on renderer internals and want the lower-level exports directly.

## Documentation

- [`../../docs/PUBLIC_API.md`](../../docs/PUBLIC_API.md)
- [`../../docs/REACT_INTEGRATION_GUIDE.md`](../../docs/REACT_INTEGRATION_GUIDE.md)
- [`../../docs/SECURITY_MODEL.md`](../../docs/SECURITY_MODEL.md)
- [`../../docs/STREAMING_CORRECTNESS_CONTRACT.md`](../../docs/STREAMING_CORRECTNESS_CONTRACT.md)
- Docs site: <https://stream-mdx.vercel.app/docs>
