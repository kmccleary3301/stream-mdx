# @stream-mdx/unified

Remark and Rehype unified plugin adapter for StreamMDX (`StreamingMarkdown`).

Enables `react-markdown` and `Streamdown` users to bring their existing `remarkPlugins` and `rehypePlugins` to StreamMDX without sacrificing streaming performance.

## How It Works

- **Finalized-only execution**: Unified plugins run only on finalized blocks. Provisional blocks continue to use the native StreamMDX renderer.
- **Sync and async pipelines**: Synchronous plugins execute once per cache key and support `renderToStaticMarkup` and `renderToString`. Asynchronous plugins retain the default rendered element while pending and commit their result on the client.
- **Async SSR behavior**: Server rendering with async plugins returns the default StreamMDX element. It does not wait for plugin completion.
- **Deduplication and stale results**: Concurrent jobs for the same cache key share one transformation. Older jobs may finish after content or metadata changes, but their results cannot replace the newer block.
- **Bounded cache**: Finalized transformations use a bounded LRU cache, with 500 entries by default. Keys include `block.id`, block type, reconstructed markdown source, and resolved link references.
- **Link reference resolution**: Definitions from `block.payload.meta.linkReferences` are prepended before parsing, so routed blocks retain resolved reference links and titles.
- **Container replacement**: Routed lists and blockquotes run their canonical raw markdown through unified and replace native child rendering, including prepared child snapshots. Set `blockTypes` to exclude those containers when you need native code, math, or custom syntax renderers inside them. Unrouted containers retain their native element.
- **Error handling**: Unified processing errors reach `onError` with the block's ID, type, and finalized state, while retaining the default rendered element. Promise rejections and callback-style transformer errors use the same fallback.
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
  components: {
    heading: {
      wrapper: ({ children, metadata }) => (
        <section data-finalized={metadata.isFinalized}>{children}</section>
      ),
    },
  },
  hastComponents: {
    a: (props) => <a {...props} className="text-blue-500 hover:underline" />,
  },
  onError: (error, context) => {
    console.error(`Unified plugin error in block ${context.id}:`, error);
  },

export function Doc({ text }: { text: string }) {
  return (
    <StreamingMarkdown
      text={text}
      components={unifiedRenderer}
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
| `components` | `NodePresentations` | `{}` | Node wrapper/view registry shared with the streaming and static React renderer |
| `hastComponents` | `Record<string, Component>` | `{}` | Custom React component mapping passed to `hast-util-to-jsx-runtime` |
| `blockTypes` | `string[]` | `['paragraph', 'heading', 'blockquote', 'list', 'table', 'code', 'hr']` | Block types to route to unified pipeline |
| `cacheSize` | `number` | `500` | Maximum number of rendered blocks to retain in LRU cache |
| `math` | `boolean` | `false` | Enable `remark-math` support |
| `gfm` | `boolean` | `true` | Enable `remark-gfm` support |
| `onError` | `(error: Error, context: { id: string; type: string; finalized: boolean }) => void` | `undefined` | Callback invoked when unified processing fails for a block |

> **Note on Block Types**: Standard CommonMark/GFM blocks are routed by default. Specialized block types like `html` and `mdx` are opt-in via `blockTypes` (e.g. `blockTypes: ['paragraph', 'html']`). When routing `html` blocks, ensure your unified pipeline includes appropriate plugins (e.g. `rehype-raw`) if you wish to parse embedded raw HTML.
