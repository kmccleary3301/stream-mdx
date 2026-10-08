# Plugins and Extensions

## Features are the default switchboard

Most behavior is enabled with the `features` prop:

```tsx
<StreamingMarkdown
  text={content}
  features={{
    tables: true,
    html: true,
    mdx: true,
    math: true,
    footnotes: true,
    callouts: true,
  }}
/>
```

You do not need to pass plugins for common features. The worker already knows how to parse these blocks.

## Custom syntax and custom worker bundles

If you need custom syntax (custom regex, domain tokens, or non-standard blocks), build a custom worker bundle and enable the plugin there. The `Mermaid` addon is a good example of an opt-in block renderer.

### Worker bundle workflow

1. Start from the default worker package.
2. Add your plugin registry setup.
3. Build a hosted worker bundle.

```ts
import { createWorkerRegistry } from "@stream-mdx/plugins";
import { mathPlugin } from "@stream-mdx/plugins/math";

const registry = createWorkerRegistry();
registry.use(mathPlugin());
```

## Mermaid diagrams

Mermaid is an optional addon that turns ```mermaid code fences into diagrams. It does not change the parser; it replaces the code block renderer for `mermaid` fences.

```tsx
import { MermaidBlock } from "@stream-mdx/mermaid";

<StreamingMarkdown
  text={content}
  codeRenderers={{ mermaid: MermaidBlock }}
/>
```

## Remark and Rehype plugins (@stream-mdx/unified)

If you are migrating from `react-markdown` or `Streamdown` and want to reuse existing remark or rehype plugins, install `@stream-mdx/unified`:

```bash
npm install @stream-mdx/unified
```

To maintain zero-lag streaming, unified plugins run **only on finalized blocks**. Active streaming blocks are displayed by the Lezer-native StreamMDX engine.

```tsx
import { StreamingMarkdown } from "stream-mdx";
import { createUnifiedRenderer } from "@stream-mdx/unified";
import rehypeSlug from "rehype-slug";

const unifiedRenderer = createUnifiedRenderer({
  rehypePlugins: [rehypeSlug],
});

<StreamingMarkdown
  text={content}
  blockRenderer={unifiedRenderer}
/>
```

You can also pass custom React components via `components` to customize elements rendered by the unified pipeline.

## Custom regex patterns

Regex patterns typically live in a custom worker bundle. If you only need rendering changes (no parsing), use `components` and `inlineComponents`.

### Example: citation syntax

```ts
// Worker-side: register a custom regex block/inline matcher.
registry.use({
  name: "citation",
  inline: {
    full: /\{cite:(\d+)\}/g,
    start: /\{cite:/g,
    render: ({ match }) => ({ type: "inline", tag: "span", props: { className: "citation", children: `[${match[1]}]` } }),
  },
});
```

If you enable format anticipation for regex, use `start` patterns that are safe to close within a newline boundary.

## Format anticipation

Format anticipation is a feature for rendering incomplete emphasis or math segments before the closing marker arrives. It is controlled via the `features.formatAnticipation` config (see the public API docs).
