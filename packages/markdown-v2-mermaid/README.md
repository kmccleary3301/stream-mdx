# `@stream-mdx/mermaid`

`@stream-mdx/mermaid` is the opt-in Mermaid addon for StreamMDX. Register it in `codeRenderers.mermaid` and fenced `mermaid` code blocks render as diagrams with a code/diagram toggle.

## Install

```bash
npm install @stream-mdx/mermaid
```

## Usage

```tsx
import { StreamingMarkdown } from "stream-mdx";
import { MermaidBlock } from "@stream-mdx/mermaid";

export function Demo() {
  return (
    <StreamingMarkdown
      text={"```mermaid\ngraph TD; A-->B;\n```"}
      worker="/workers/markdown-worker.js"
      codeRenderers={{ mermaid: MermaidBlock }}
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
import { StreamingMarkdown } from "stream-mdx";
import { MermaidBlock } from "@stream-mdx/mermaid";

export function CustomDiagram({ text }: { text: string }) {
  return (
    <StreamingMarkdown
      text={text}
      codeRenderers={{
        mermaid: (props) => <MermaidBlock {...props} debounceMs={250} defaultView="diagram" />,
      }}
    />
  );
}
```

`MermaidBlock` accepts the code fence renderer props. `renderCode` is an already rendered React node used by the Code view. Set `deferHeavyBlocks` on `StreamingMarkdown` to use Mermaid's viewport deferral.

## Documentation

- [`../../docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`](../../docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md)
- Mermaid guide on the docs site: <https://stream-mdx.vercel.app/guides/mermaid-diagrams>
