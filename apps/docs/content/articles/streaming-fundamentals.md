# Streaming Fundamentals

## What streaming means in StreamMDX

Streaming is not just "append text and re-render everything". StreamMDX keeps a structured tree of blocks and patches that tree as new text arrives. The result is:

- stable DOM nodes for completed content
- fast incremental updates for new content
- lower memory churn during long outputs

You can use StreamMDX with either a full string (`text`) or an append-only stream (`stream`). The component behaves the same either way; streaming just lets you render as the data arrives.

## Data flow in one pass

1. **Append**: new text is appended to a worker-side buffer.
2. **Parse**: the worker turns the buffer into a block tree (headings, paragraphs, code blocks, lists, etc.).
3. **Patch**: only the differences are sent to the UI.
4. **Render**: the renderer applies patches and updates React without rebuilding the entire tree.

The pipeline looks like this:

```
input text -> worker -> blocks -> patches -> renderer -> React
```

## Worker vs server compilation

There are two compilation strategies for MDX:

- **Worker** (recommended): all compilation happens in the worker for maximal parity.
- **Server**: you host a compile endpoint and StreamMDX calls it when MDX is encountered.

If you are unsure, start with worker mode:

```tsx
<StreamingMarkdown
  text={content}
  worker="/workers/markdown-worker.js"
  features={{ mdx: true, html: true, math: true, tables: true }}
  mdxCompileMode="worker"
/>
```

## Minimal streaming example

```tsx
"use client";

import { StreamingMarkdown } from "stream-mdx";

export function StreamExample({ stream }: { stream: AsyncIterable<string> }) {
  return (
    <StreamingMarkdown
      stream={stream}
      worker="/workers/markdown-worker.js"
      features={{ html: true, tables: true, mdx: true, math: true }}
      mdxCompileMode="worker"
    />
  );
}
```

If you already have the full text, just pass `text` instead of `stream`.

## What is "stable" output?

StreamMDX keeps rendered blocks stable once they are complete. A completed paragraph will not re-render unless the incoming text actually changes that paragraph. This is what keeps long renders smooth even at high throughput.

The two main rules are:

- **Only the tail changes** while streaming. Completed blocks are reused.
- **Patches are small** and reflect structural changes only when needed.

## Common pitfalls

- **Mixing `text` and `stream`**: the component expects exactly one.
- **Server component imports**: `StreamingMarkdown` must be in a client component.
- **Missing worker bundle**: remember to copy the hosted worker to static assets.

## Checklist for first-time streaming

- [ ] Host the worker bundle in `public/workers/markdown-worker.js`.
- [ ] Pass `worker="/workers/markdown-worker.js"`.
- [ ] Start with `features={{ html: true, tables: true, math: true, mdx: true }}`.
- [ ] Use `mdxCompileMode="worker"` for parity.

