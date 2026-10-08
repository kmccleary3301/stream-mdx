# @stream-mdx/unified

Remark and Rehype unified plugin adapter for StreamMDX (`StreamingMarkdown`).

Enables `react-markdown` and `Streamdown` users to bring their existing `remarkPlugins` and `rehypePlugins` to StreamMDX without sacrificing streaming performance.

## How It Works

- **Finalized-only execution**: Unified plugins run **only** on finalized blocks. While a block is streaming, the high-performance Lezer-native StreamMDX renderer displays it with zero lag.
- **Sync & Async pipeline support**: Synchronous plugins execute immediately, providing synchronous SSR (`renderToStaticMarkup`, `renderToString`) with zero duplicated execution. Asynchronous plugins process off the streaming critical path, retaining the default rendered element while pending and committing the result once complete.
- **Async SSR behavior**: When async plugins are configured, server rendering yields the default StreamMDX element. On the client, the async pipeline resolves and updates the block without blocking user interaction or hydration.
- **Deduplication & cancellation**: Concurrent jobs for the same block and cache key are deduplicated. When metadata or content updates, stale in-flight jobs are cancelled and cannot overwrite newer content.
- **Bounded LRU cache**: Finalized transformations are cached in a bounded LRU cache (default 500 entries) keyed by `block.id` + raw source content + resolved link references.
- **Link reference resolution**: Resolved link reference definitions attached to block metadata (`block.payload.meta.linkReferences`) are prepended before parsing, so reference links resolve inside routed blocks.
- **Error handling**: Plugin exceptions (synchronous or asynchronous) are reported via the explicit `onError` hook while safely falling back to the default rendered element with zero unhandled rejections.
- **Zero bundle weight in `@stream-mdx/react`**: Heavy unified and AST parser dependencies remain isolated within `@stream-mdx/unified`.

## Installation

```bash
npm install @stream-mdx/unified
```

## Usage

```tsx
import { StreamingMarkdown } from "@stream-mdx/react";
import { createUnifiedRenderer } from "@stream-mdx/unified";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";

const unifiedRenderer = createUnifiedRenderer({
  rehypePlugins: [rehypeSlug, rehypeAutolinkHeadings],
  // Optional custom components mapping
  components: {
    a: (props) => <a {...props} className="text-blue-500 hover:underline" />,
  },
  onError: (error, block) => {
    console.error(`Unified plugin error in block ${block.id}:`, error);
  },
});

export function Doc({ text }: { text: string }) {
  return (
    <StreamingMarkdown
      text={text}
      blockRenderer={unifiedRenderer}
    />
  );
}
```

## Options

`createUnifiedRenderer(options)` accepts:

| Option | Type | Default | Description |
|---|---|---|---|
| `remarkPlugins` | `PluggableList` | `[]` | List of remark plugins or plugin tuples `[plugin, options]` |
| `rehypePlugins` | `PluggableList` | `[]` | List of rehype plugins or plugin tuples `[plugin, options]` |
| `components` | `Record<string, Component>` | `{}` | Custom React component mapping passed to `hast-util-to-jsx-runtime` |
| `blockTypes` | `string[]` | `['paragraph', 'heading', 'blockquote', 'list', 'table', 'code', 'thematicBreak']` | Block types to route to unified pipeline |
| `cacheSize` | `number` | `500` | Maximum number of rendered blocks to retain in LRU cache |
| `math` | `boolean` | `false` | Enable `remark-math` support |
| `gfm` | `boolean` | `true` | Enable `remark-gfm` support |
| `onError` | `(error: Error, block: Block) => void` | `undefined` | Callback invoked when a unified plugin throws during block processing |

> **Note on Block Types**: Standard CommonMark/GFM blocks are routed by default. Specialized block types like `html` and `mdx` are opt-in via `blockTypes` (e.g. `blockTypes: ['paragraph', 'html']`). When routing `html` blocks, ensure your unified pipeline includes appropriate plugins (e.g. `rehype-raw`) if you wish to parse embedded raw HTML.
