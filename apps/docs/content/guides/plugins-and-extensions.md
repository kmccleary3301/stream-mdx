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
import type { DocumentPlugin } from "@stream-mdx/plugins/document";
import { serveMarkdownWorker } from "@stream-mdx/worker/engine";

const customPlugin: DocumentPlugin = {
  name: "custom-plugin",
  process(ctx) {
    // Custom document transformation
    return undefined;
  },
};

serveMarkdownWorker({
  extensions: {
    documentPlugins: [customPlugin],
  },
});
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

## Code fence renderers

Register a custom renderer with `codeRenderers` for any fence language. Mermaid is available as an optional addon:

```tsx
import { StreamingMarkdown } from "@stream-mdx/react";
import { MermaidBlock } from "@stream-mdx/mermaid";

<StreamingMarkdown
  text={content}
  codeRenderers={{
    mermaid: MermaidBlock,
    custom: ({ renderCode }) => <section>{renderCode}</section>,
  }}
/>
```

Fences labeled `artifact` or `html-artifact` remain code unless the host provides a renderer. StreamMDX has no built-in artifact frame or sandbox. A custom renderer that activates source content needs a host-owned security boundary.

For security guidance and the chat-thread demo, see the [Deployment and Security Guide](/docs/guides/deployment-and-security#agent-content-and-code-renderers) and [`/showcase/assistant-stream`](/showcase/assistant-stream).

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

Both synchronous and asynchronous remark/rehype plugins are supported. Synchronous plugins execute immediately for SSR compatibility, while asynchronous plugins process off the streaming critical path without blocking streaming or hydration.

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
