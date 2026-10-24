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

Mermaid is an optional addon that turns ```mermaid code fences into diagrams. A `components.code.wrapper` presentation routes Mermaid blocks and returns the prepared native code children for other languages:

```tsx
import { StreamingMarkdown, type NodeViewProps } from "stream-mdx";
import { MermaidBlock } from "@stream-mdx/mermaid";

function MermaidPresentation({ block, children, metadata, actions }: NodeViewProps) {
  if (metadata.language?.toLowerCase() !== "mermaid") return children;
  const code = block?.payload.meta?.code;
  return (
    <MermaidBlock
      code={typeof code === "string" ? code : ""}
      renderCode={children}
      language={metadata.language ?? "mermaid"}
      blockId={metadata.id}
      controls={{ copy: true }}
      copy={actions.copy}
    />
  );
}

<StreamingMarkdown text={content} components={{ code: { wrapper: MermaidPresentation } }} />
```

## Code presentations

Use a code wrapper to route custom languages while leaving every other block on the native rendering path:

```tsx
import { StreamingMarkdown, type NodeViewProps } from "stream-mdx";
import { MermaidBlock } from "@stream-mdx/mermaid";

function CodePresentation({ block, children, metadata, actions }: NodeViewProps) {
  const language = metadata.language?.toLowerCase();
  const code = block?.payload.meta?.code;
  if (language === "mermaid") {
    return (
      <MermaidBlock
        code={typeof code === "string" ? code : ""}
        renderCode={children}
        language={metadata.language ?? "mermaid"}
        blockId={metadata.id}
        controls={{ copy: true }}
        copy={actions.copy}
      />
    );
  }
  if (language === "custom") return <section>{children}</section>;
  return children;
}

<StreamingMarkdown text={content} components={{ code: { wrapper: CodePresentation } }} />
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

const unifiedComponents = createUnifiedRenderer({
  rehypePlugins: [rehypeSlug],
});

<StreamingMarkdown
  text={content}
  components={unifiedComponents}
/>
```

Both synchronous and asynchronous remark/rehype plugins are supported. Synchronous plugins execute immediately for SSR compatibility, while asynchronous plugins process off the streaming critical path without blocking streaming or hydration.

## Custom regex patterns

Regex patterns typically live in a custom worker bundle. For rendering-only changes, use `components` with block/inline presentation keys such as `"code"` and `"extension:citation"`.

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
