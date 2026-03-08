# @stream-mdx/mermaid

Mermaid diagram rendering addon for StreamMDX.

This package is **opt-in**. Install it and register the `mermaid` block component so ` ```mermaid ` code fences render as diagrams (with a Diagram/Code toggle).

## Install

```bash
npm install @stream-mdx/mermaid
```

## Usage

```tsx
import { StreamingMarkdown } from "@stream-mdx/react";
import { MermaidBlock } from "@stream-mdx/mermaid";

export function Demo() {
  return (
    <StreamingMarkdown
      text={"```mermaid\\ngraph TD; A-->B;\\n```"}
      components={{
        mermaid: MermaidBlock,
      }}
    />
  );
}
```

## Customization

If you want to tune debounce or default view, wrap the component:

```tsx
components={{
  mermaid: (props) => <MermaidBlock {...props} debounceMs={250} defaultView="diagram" />,
}}
```

## Docs

- Mermaid guide: https://github.com/kmccleary3301/stream-mdx/blob/main/docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md#mermaid-addon-optional
- Docs site walkthrough: https://kmccleary3301.github.io/stream-mdx/docs/guides/mermaid-diagrams
