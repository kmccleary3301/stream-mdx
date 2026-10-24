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

## Custom syntax and worker bundles

Use the `syntax` prop with a `SyntaxExtensionDescriptor` for serializable inline rules and registered colon containers. Native Lezer extensions and document plugins are functions, so bundle them into a custom worker instead of sending them through `INIT`. Mermaid is an opt-in engine registered through `engines.mermaid`.

### Worker bundle workflow

1. Start from the default worker package.
2. Register a `DocumentPlugin` or `InlineExtension` under `extensions`.
3. Build a hosted worker bundle.

```ts
import { headingMetadata } from "./heading-metadata";
import { serveMarkdownWorker } from "@stream-mdx/worker/engine";

serveMarkdownWorker({
  extensions: {
    documentPlugins: [headingMetadata],
  },
});
```

## Mermaid diagrams

Mermaid is an optional addon that routes `mermaid` fences through `engines.mermaid`:

```tsx
import { StreamingMarkdown } from "stream-mdx";
import { createMermaidEngine } from "@stream-mdx/mermaid";

const mermaidEngine = createMermaidEngine();

<StreamingMarkdown text={content} engines={{ mermaid: mermaidEngine }} />;
```

This keeps Mermaid rendering in the native code-owner path without a language wrapper or a `block.payload` read. The engine can also be configured with `createMermaidEngine({ config, defaultView, debounceMs })`.

## Code presentations

Use `components.code.wrapper` to route presentation by bounded metadata while preserving the prepared native children. Wrappers no longer receive the full `Block`:

```tsx
import { StreamingMarkdown, type NodeViewProps } from "stream-mdx";

function CodePresentation({ children, metadata }: NodeViewProps) {
  if (metadata.language?.toLowerCase() !== "custom") return children;
  return <section data-code-language={metadata.language}>{children}</section>;
}

<StreamingMarkdown text={content} components={{ code: { wrapper: CodePresentation } }} />;
```

Use `engines.code` with a `CodeEngine` for custom tokenization; it requires `engine="main"`. A code renderer that changes visual presentation remains under `components.code`.

## Keep artifact fences inert

Fences labeled `artifact` or `html-artifact` remain code unless the host supplies an explicit presentation. StreamMDX does not provide a default artifact frame or sandbox. A presentation that activates source content needs a host-owned security boundary.

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

## Declarative syntax extensions

Pass custom inline rules as a serializable `SyntaxExtensionDescriptor`. Render a matched rule by its name with `components["extension:<name>"]`:

```tsx
import { StreamingMarkdown, type InlineNodeViewProps } from "stream-mdx";
import type { SyntaxExtensionDescriptor } from "@stream-mdx/core";

const syntax: SyntaxExtensionDescriptor = {
  contractVersion: 1,
  inline: [{
    name: "citation",
    pattern: { source: "\\{cite:(\\d+)\\}" },
    trigger: "{cite:",
    attrs: { id: 1 },
  }],
};

function CitationView({ node }: InlineNodeViewProps) {
  if (node.kind !== "plugin") return null;
  return <span className="citation">[{node.attrs?.id ?? ""}]</span>;
}

<StreamingMarkdown
  text="See {cite:42}."
  syntax={syntax}
  components={{ "extension:citation": { view: CitationView } }}
/>;
```

Syntax descriptors can also register colon containers whose `component` names an entry in `contentComponents`. A rule can use `anticipation: { open, close }` for incomplete streaming input. See the [Plugin ABI](https://github.com/kmccleary3301/stream-mdx/blob/main/docs/PLUGIN_ABI.md) for the descriptor fields and admission behavior.

## Format anticipation

Format anticipation is a feature for rendering incomplete emphasis or math segments before the closing marker arrives. It is controlled via the `features.formatAnticipation` config (see the public API docs).
