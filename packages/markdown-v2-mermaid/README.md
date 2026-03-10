# `@stream-mdx/mermaid`

`@stream-mdx/mermaid` is the opt-in Mermaid addon for StreamMDX. Register it as the `mermaid` block renderer and fenced `mermaid` code blocks will render as diagrams with a code/diagram toggle.

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
      components={{ mermaid: MermaidBlock }}
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

## Customization

```tsx
components={{
  mermaid: (props) => <MermaidBlock {...props} debounceMs={250} defaultView="diagram" />,
}}
```

## Documentation

- [`../../docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`](../../docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md)
- Mermaid guide on the docs site: <https://stream-mdx.vercel.app/guides/mermaid-diagrams>
