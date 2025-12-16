# `@stream-mdx/plugins`

Tree-shakable feature plugins for Streaming Markdown V2. Each plugin exports worker + React hooks so you can opt into math, MDX, tables, HTML, or callouts without pulling the entire surface area.

## Packages

- `@stream-mdx/plugins/math`
- `@stream-mdx/plugins/mdx`
- `@stream-mdx/plugins/tables`
- `@stream-mdx/plugins/html`
- `@stream-mdx/plugins/callouts`

Every plugin exposes a `createXPlugin()` function returning a descriptor that the renderer wires into both the worker and React registries.

## Usage

```tsx
import { StreamingMarkdown } from "@stream-mdx/react";
import { mathPlugin } from "@stream-mdx/plugins/math";
import { mdxPlugin } from "@stream-mdx/plugins/mdx";

const plugins = [mathPlugin(), mdxPlugin({ components: { YouTube } })];

<StreamingMarkdown text={markdown} plugins={plugins} features={{ html: true }} />;
```

Pair plugin usage with the relevant feature flags if you want belt-and-suspenders toggles.

## Resources

- Cookbook: `docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md` (examples, tree-shaking tips).
- Math + MDX worker/renderer recipe: `docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md#5-math--mdx-workerrenderer-registration`.
- Public API: `docs/PUBLIC_API.md#plugins`.

## Status

- [ ] Document per-plugin options & defaults inline.
- [ ] Publish bundle size notes (math vs mdx vs tables).*** End Patch*** End Patch to packages/markdown-v2-plugins/README.md
