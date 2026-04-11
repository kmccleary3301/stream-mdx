# `stream-mdx`

[![npm version](https://img.shields.io/npm/v/stream-mdx?logo=npm&color=CB3837)](https://www.npmjs.com/package/stream-mdx)
[![Docs](https://img.shields.io/badge/docs-stream--mdx.vercel.app-000000?logo=vercel)](https://stream-mdx.vercel.app/docs)
[![License](https://img.shields.io/github/license/kmccleary3301/stream-mdx?color=2ea44f)](../../LICENSE)

`stream-mdx` is the convenience package for StreamMDX. If you want the standard React/browser integration without thinking about the scoped package layout, start here.

**Primary links**: [Root README](../../README.md) · [Docs site](https://stream-mdx.vercel.app/docs) · [Public API](../../docs/PUBLIC_API.md) · [React integration](../../docs/REACT_INTEGRATION_GUIDE.md)

## What This Package Includes

`stream-mdx` re-exports the commonly used parts of the stack under stable app-facing import paths:

| Import | Resolves to | Use when |
| --- | --- | --- |
| `stream-mdx` | main React surface | You want `<StreamingMarkdown />` and the default types. |
| `stream-mdx/react` | `@stream-mdx/react` | You want the React surface explicitly. |
| `stream-mdx/worker` | `@stream-mdx/worker` | You need worker helpers or hosted worker utilities. |
| `stream-mdx/worker/node` | `@stream-mdx/worker/node` | You want Node `worker_threads` snapshot compilation. |
| `stream-mdx/worker/direct` | `@stream-mdx/worker/direct` | You need direct compile helpers in runtimes without `worker_threads`. |
| `stream-mdx/core` | `@stream-mdx/core` | You need lower-level types or perf helpers. |
| `stream-mdx/plugins/*` | `@stream-mdx/plugins/*` | You are customizing the worker/plugin layer. |

If you are building a framework integration or need absolute control over dependency edges, install the scoped packages directly instead.

## Install

```bash
npm install stream-mdx
```

Peer dependencies:

| Package | Range |
| --- | --- |
| `react` | `>=18.2.0` |
| `react-dom` | `>=18.2.0` |

## Quickstart

### 1. Host the worker bundle

```bash
mkdir -p public/workers
cp node_modules/@stream-mdx/worker/dist/hosted/markdown-worker.js public/workers/markdown-worker.js
```

### 2. Render Markdown in a client component

```tsx
"use client";

import { StreamingMarkdown } from "stream-mdx";

export function Demo({ text }: { text: string }) {
  return (
    <StreamingMarkdown
      text={text}
      worker="/workers/markdown-worker.js"
      features={{ tables: true, html: true, math: true, mdx: true, footnotes: true }}
      mdxCompileMode="worker"
      prewarmLangs={["tsx", "bash", "json"]}
    />
  );
}
```

### 3. Optional addon registration

```tsx
import { MermaidBlock } from "@stream-mdx/mermaid";
import { StreamingMarkdown } from "stream-mdx";

<StreamingMarkdown text={content} worker="/workers/markdown-worker.js" components={{ mermaid: MermaidBlock }} />;
```

> [!NOTE]
> `StreamingMarkdown` is a client component. In Next.js App Router, keep the import behind a `"use client"` boundary.

## Package-Specific Guidance

| Question | Recommendation |
| --- | --- |
| I just want the normal React integration. | Use `stream-mdx`. |
| I need the worker/runtime pieces separately. | Use `@stream-mdx/worker` and `@stream-mdx/core`. |
| I am building a server/static compilation pipeline. | Use `stream-mdx/worker/node` plus `@stream-mdx/react/server`. |
| I need plugin customization or a custom worker bundle. | Drop to `@stream-mdx/plugins/*`. |
| I am building a TUI or protocol consumer. | Use `@stream-mdx/protocol` and `@stream-mdx/tui`. |

## Common Usage Patterns

### Simple static string

```tsx
<StreamingMarkdown text="# Hello\n\nStreaming **markdown**" worker="/workers/markdown-worker.js" />
```

### Append-only stream

```tsx
<StreamingMarkdown stream={myAsyncIterable} worker="/workers/markdown-worker.js" caret="block" />
```

### Server / static snapshot compile

```tsx
import { ComponentRegistry, MarkdownBlocksRenderer } from "@stream-mdx/react/server";
import { compileMarkdownSnapshot } from "stream-mdx/worker/node";

const { blocks } = await compileMarkdownSnapshot({
  text: "# Precompiled page\n\nThis was rendered from a snapshot.",
  init: {
    docPlugins: { tables: true, html: true, mdx: true, math: true, footnotes: true },
    mdx: { compileMode: "server" },
  },
});

return <MarkdownBlocksRenderer blocks={blocks} componentRegistry={new ComponentRegistry()} />;
```

## Related Packages

| Package | Role |
| --- | --- |
| [`@stream-mdx/react`](../markdown-v2-react/README.md) | React renderer and server helpers |
| [`@stream-mdx/worker`](../markdown-v2-worker/README.md) | Worker utilities, hosted worker, Node helpers |
| [`@stream-mdx/core`](../markdown-v2-core/README.md) | Core types, snapshots, perf helpers |
| [`@stream-mdx/plugins`](../markdown-v2-plugins/README.md) | Worker/plugin primitives |
| [`@stream-mdx/mermaid`](../markdown-v2-mermaid/README.md) | Mermaid addon |
| [`@stream-mdx/protocol`](../markdown-v2-protocol/README.md) | Protocol contracts |
| [`@stream-mdx/tui`](../markdown-v2-tui/README.md) | TUI helpers |
| [`@stream-mdx/theme-tailwind`](../theme-tailwind/README.md) | Optional theme CSS |

## Documentation

- [`../../docs/GETTING_STARTED.md`](../../docs/GETTING_STARTED.md)
- [`../../docs/PUBLIC_API.md`](../../docs/PUBLIC_API.md)
- [`../../docs/REACT_INTEGRATION_GUIDE.md`](../../docs/REACT_INTEGRATION_GUIDE.md)
- [`../../docs/TUI_GUIDE.md`](../../docs/TUI_GUIDE.md)
- [`../../docs/SECURITY_MODEL.md`](../../docs/SECURITY_MODEL.md)
- [`../../docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`](../../docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md)
- [`../../docs/BASELINE_UPDATE_POLICY.md`](../../docs/BASELINE_UPDATE_POLICY.md)
