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
| `@stream-mdx/react/trusted-mdx` | Explicit trusted-MDX engine factory and pure contract types |

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
      features={{ html: true, tables: true, math: true, footnotes: true }}
    />
  );
}
```

`engine` defaults to `"auto"`. It tries a browser Worker and dynamically imports the in-process engine only when Worker creation is unavailable or fails. `"worker"` requires a Worker; `"main-thread"` skips the Worker and runs parsing on the browser thread. Engine setup runs after mounting, not during SSR. Use compiled snapshots and the server entry for server markup.

`mathRenderer` replaces math views; `features.math: false` disables math parsing. See the [public API](../../docs/PUBLIC_API.md) for HTML policy, restricted/trusted MDX, inert artifact fences, and optional finalized-block unified routing.

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

### Code viewport and printing

Large native code blocks use a bounded reader viewport. The **Show full content** control mounts all authored lines while retaining the existing code wrapper and mounted native rows; toggling back restores the bounded window and reader anchor.

`StreamingMarkdown` accepts `codeVirtualization?: Partial<VirtualizedCodeConfig>` to configure native code viewport presentation:

```tsx
<StreamingMarkdown text={content} codeVirtualization={{ followTail: true }} />
```

`followTail` defaults to `false`, preserving the reader position when code is appended. Set it to `true` to opt in to following appended rows while attached at the physical bottom (within 2px). An upward scroll of more than 1px detaches; returning within 2px reattaches. Changing this presentation config does not reset authored source or replace the native viewport; turning `followTail` off preserves the existing reader anchor and scroll position on a subsequent append.

When a browser dispatches `beforeprint`, an eligible virtualized native code block temporarily mounts its full source and removes viewport clipping and height limits. `afterprint` restores the prior reader mode, scroll anchor, and native text selection without changing the manual full-content control.

Print preparation mounts the whole block in the DOM, so print-time memory and layout work scale with the source length. Custom code renderers and server-rendered output control their own print behavior.

Native whole-code copy/download uses cold authored source, preserving CR/LF and trailing blank lines rather than normalized display text. The test DOM exercises copy with an active selection and a Clipboard API stub; no physical browser or OS clipboard proof is claimed. Download shares the source action, but direct Blob browser proof remains pending. Native copied-status feedback cleanup prevents delayed updates after unmount.
Each eligible virtualized table also exposes a "Show full content" toggle. It mounts every row only on request; toggling it again restores the bounded viewport without replacing the native table or changing the reader's scroll position.


### Table controls

Table controls are off by default. Enable Markdown copy or download for tables with `controls`:

```tsx
<StreamingMarkdown
  text={content}
  features={{ tables: true }}
  controls={{ table: { copy: ["markdown"], download: ["markdown"] } }}
/>
```

For native tables, Markdown copy and download use the table's authored source slice. They preserve spacing, escaped pipes, inline Markdown, and original line endings, and exclude the final row's line ending and any following document content. TSV and CSV remain cell-value transforms, not source-preserving Markdown.

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
