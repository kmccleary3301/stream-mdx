# @stream-mdx/unified

Remark and Rehype unified plugin adapter for StreamMDX (`StreamingMarkdown`).

Enables `react-markdown` and `Streamdown` users to bring their existing `remarkPlugins` and `rehypePlugins` to StreamMDX without sacrificing streaming performance.

## How It Works

- **Finalized-only execution**: Unified plugins run **only** on finalized blocks. While a block is streaming, the high-performance Lezer-native StreamMDX renderer displays it with zero lag.
- **One-time cost per block**: Finalized blocks never receive more source text, so transformations are computed once and cached by `block.id` + raw source content.
- **Document context aware**: Document-level link reference definitions (`[label]: https://...`) are preserved so reference links resolve inside routed blocks.
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
| `blockTypes` | `string[]` | `['paragraph', 'heading', 'blockquote', 'list', 'table', 'code', 'hr']` | Block types to route to unified pipeline |
| `linkReferences` | `string \| (() => string)` | `undefined` | Custom link reference definitions (otherwise extracted from document text) |
| `math` | `boolean` | `false` | Enable `remark-math` support |
| `gfm` | `boolean` | `true` | Enable `remark-gfm` support |
