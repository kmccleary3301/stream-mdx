# `@stream-mdx/mermaid`

`@stream-mdx/mermaid` is the opt-in Mermaid addon for StreamMDX. Compose `MermaidBlock` through `components.code` and route Mermaid fences using the presentation's `metadata.language`.

## Install

```bash
npm install @stream-mdx/mermaid
```

## Usage

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

export function Demo() {
  return (
    <StreamingMarkdown
      text={"```mermaid\ngraph TD; A-->B;\n```"}
      worker="/workers/markdown-worker.js"
      components={{ code: { wrapper: MermaidPresentation } }}
    />
  );
}
```

## What It Adds

| Capability | Notes |
| --- | --- |
| Diagram view | Render Mermaid diagrams in-place |
| Code view toggle | Keep the source visible and inspectable |
| Opt-in registration | Only affects `mermaid` blocks when you register the component |

Incomplete or invalid diagrams report errors inside their own block. Once valid source arrives, the diagram replaces that error without leaving an error SVG elsewhere on the page.

## Customization

```tsx
import { StreamingMarkdown, type NodeViewProps } from "stream-mdx";
import { MermaidBlock } from "@stream-mdx/mermaid";

function CustomMermaidPresentation({ block, children, metadata, actions }: NodeViewProps) {
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
      debounceMs={250}
      defaultView="diagram"
    />
  );
}

export function CustomDiagram({ text }: { text: string }) {
  return (
    <StreamingMarkdown
      text={text}
      components={{ code: { wrapper: CustomMermaidPresentation } }}
    />
  );
}
```

`MermaidBlock` still accepts the diagram source and rendered native code as props; the `components.code` wrapper routes by `metadata.language`. Set `deferHeavyBlocks` on `StreamingMarkdown` to use Mermaid's viewport deferral.

If a custom `mermaid` provider's `bindFunctions` installs provider-global effects, it MUST return a disposer. `MermaidBlock` calls it when the rendered artifact is replaced, the block leaves Diagram view, or the block unmounts. Existing `void`-returning callbacks remain supported, but they cannot undo effects outside the SVG root.

## Documentation
- [`../../docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`](../../docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md)
- Mermaid guide on the docs site: <https://stream-mdx.vercel.app/guides/mermaid-diagrams>
