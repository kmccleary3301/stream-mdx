# `@stream-mdx/mermaid`

`@stream-mdx/mermaid` is the opt-in Mermaid addon for StreamMDX. Compose `MermaidBlock` through `components.code` and route Mermaid fences using the presentation's `metadata.language`.

## Install

```bash
npm install @stream-mdx/mermaid
```

## Usage

```tsx
import { StreamingMarkdown } from "stream-mdx";
import { createMermaidEngine } from "@stream-mdx/mermaid";

const mermaidEngine = createMermaidEngine();

export function Demo() {
  return (
    <StreamingMarkdown
      text={"```mermaid\ngraph TD; A-->B;\n```"}
      worker="/workers/markdown-worker.js"
      engines={{ mermaid: mermaidEngine }}
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
import { createMermaidEngine } from "@stream-mdx/mermaid";

const mermaidEngine = createMermaidEngine({
  config: { theme: "neutral" },
  defaultView: "diagram",
  debounceMs: 250,
});

export function CustomDiagram({ text }: { text: string }) {
  return <StreamingMarkdown text={text} engines={{ mermaid: mermaidEngine }} />;
}
```

`createMermaidEngine` passes its factory options to the existing Mermaid block owner. `engines.mermaid` lets the native code owner route Mermaid fences without a consumer language wrapper or `block.payload` read. Set `deferHeavyBlocks` on `StreamingMarkdown` to use Mermaid's viewport deferral.

If a custom `mermaid` provider's `bindFunctions` installs provider-global effects, it MUST return a disposer. `MermaidBlock` calls it when the rendered artifact is replaced, the block leaves Diagram view, or the block unmounts. Existing `void`-returning callbacks remain supported, but they cannot undo effects outside the SVG root.

## Documentation
- [`../../docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`](../../docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md)
- Mermaid guide on the docs site: <https://stream-mdx.vercel.app/guides/mermaid-diagrams>
