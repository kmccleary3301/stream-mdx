# @stream-mdx/unified

Remark and Rehype unified plugin adapter for StreamMDX (`StreamingMarkdown`).

Enables `react-markdown` and `Streamdown` users to bring their existing `remarkPlugins` and `rehypePlugins` to StreamMDX without sacrificing streaming performance.

## How It Works

- **Finalized-only execution**: Unified plugins run only on finalized blocks. Provisional blocks continue to use the native StreamMDX renderer.
- **Sync and async pipelines**: Synchronous plugins execute once per cache key and support `renderToStaticMarkup` and `renderToString`. Asynchronous plugins retain the default rendered element while pending and commit their result on the client.
- **Async SSR behavior**: Server rendering with async plugins returns the default StreamMDX element. It does not wait for plugin completion.
- **Deduplication and stale results**: Concurrent jobs for the same cache key share one transformation. Older jobs may finish after content or metadata changes, but their results cannot replace the newer block.
- **Bounded cache**: Finalized transformations use a bounded LRU cache, with 500 entries by default. Keys include `block.id`, block type, reconstructed markdown source, and resolved link references.
- **Heading semantics**: The engine stores finalized heading inline markdown in `payload.raw` without heading markers. The adapter restores the heading level from `payload.meta.headingLevel` before parsing, so remark heading transforms and rehype plugins such as `rehype-slug` receive a heading node.
- **Link reference resolution**: Definitions from `block.payload.meta.linkReferences` are prepended before parsing, so routed blocks retain resolved reference links and titles.
- **Container replacement**: Routed lists and blockquotes run their canonical raw markdown through unified and replace native child rendering, including prepared child snapshots. Set `blockTypes` to exclude those containers when you need native code, math, or custom syntax renderers inside them. Unrouted containers retain their native element.
- **Error handling**: Plugin errors reach `onError` and retain the default rendered element. Promise rejections and callback-style transformer errors use the same fallback.
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
