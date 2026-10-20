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

`engine` defaults to `"auto"`. It tries a browser Worker and dynamically imports the in-process engine only when Worker creation is unavailable or fails. `"worker"` requires a Worker; `"main-thread"` skips the Worker and runs parsing on the browser thread. Engine setup runs after mounting, not during SSR. Use compiled snapshots and the server entry for server markup.

Custom inline regex syntax uses `syntax` plus named `inlineComponents`. Code fences use `codeRenderers`, with optional `aliases` per entry and case-insensitive resolution. Element filtering is configured with `allowedElements`, `disallowedElements`, `allowElement`, and `unwrapDisallowed`. `disableAutolinkProtocols` disables autolinking for specific URL protocols (e.g. `["mailto"]`) while preserving explicit markdown links. `mathRenderer` replaces math views; `features.math: false` disables math parsing. See the [public API](../../docs/PUBLIC_API.md) for HTML policy, artifact sandbox/CSP, and optional finalized-block unified routing.

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

Default math stays as authored TeX source on the server and on the client's first render. KaTeX loads after commit and replaces that source after mount, so cold and preloaded clients hydrate from the same markup.

### Bottom-stick scroll area

```tsx
import { BottomStickScrollArea } from "@stream-mdx/react/components/bottom-stick-scroll-area";

<BottomStickScrollArea className="h-[32rem]">{children}</BottomStickScrollArea>;
```

Behavior notes:

- sticks to bottom while content appends
- detaches on upward user scroll
- supports smooth return-to-bottom behavior
- honors `prefers-reduced-motion: reduce` with instant jumps and no jump-chrome transition
- interrupts an active smooth return on wheel, touch, or scroll-key input without preventing native behavior
- exposes debug hooks used by deterministic checks in the repo

### Table row virtualization

```tsx
import { StreamingMarkdown } from "@stream-mdx/react";

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

Table virtualization is disabled by default. Only finalized tables meeting `minRows` virtualize after mounting in a browser and after the surrounding stream ends. SSR, unfinished tables, and active streams render every row.

Virtualized tables retain native table elements, a sticky header, measured variable row heights, and `aria-hidden` spacer rows. The last row remains reachable by scrolling.
When detached from the bottom, row measurements preserve the visible row and its pixel offset, including content partly covered by the sticky header. Scrolling chooses a new anchor; bottom attachment still follows measured tail growth.

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
