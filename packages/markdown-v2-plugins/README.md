# `@stream-mdx/plugins`

`@stream-mdx/plugins` is the worker/plugin layer for StreamMDX. It contains the built-in plugin suite plus the registry/base exports you use when you want to customize syntax support or build a custom worker bundle.

Most application code does **not** import this package directly. The normal app-facing switchboard is still the `features` prop on `<StreamingMarkdown />`.

## Install

```bash
npm install @stream-mdx/plugins
```

## Export Surface

| Export | Purpose |
| --- | --- |
| `@stream-mdx/plugins` | Main plugin surface |
| `@stream-mdx/plugins/registry` | Registry and plugin registration helpers |
| `@stream-mdx/plugins/base` | Base plugin contracts |
| `@stream-mdx/plugins/document` | Core document/plugin preset |
| `@stream-mdx/plugins/tables` | Table plugin |
| `@stream-mdx/plugins/html` | HTML plugin |
| `@stream-mdx/plugins/math` | Math plugin |
| `@stream-mdx/plugins/math/renderer` | Math rendering helpers |
| `@stream-mdx/plugins/mdx` | MDX plugin |
| `@stream-mdx/plugins/footnotes` | Footnotes plugin |
| `@stream-mdx/plugins/callouts` | Callouts plugin |

## Important Distinction

| You want to... | Use |
| --- | --- |
| Turn tables/math/html/MDX on or off in a normal app | `features={{ ... }}` on `<StreamingMarkdown />` |
| Build a custom worker bundle or extend syntax | `@stream-mdx/plugins/*` |
| Add diagram rendering | `@stream-mdx/mermaid` at the component layer |

## Example

```ts
import { createDocumentPluginPreset } from "@stream-mdx/plugins/document";
import { createTablesPlugin } from "@stream-mdx/plugins/tables";
import { createMathPlugin } from "@stream-mdx/plugins/math";
```

## When To Reach For This Package

- You are composing your own worker init/plugin preset.
- You need custom syntax or custom matcher behavior.
- You are integrating StreamMDX into a library/framework and want explicit worker-side configuration.

## Documentation

- [`../../docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`](../../docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md)
- [`../../docs/PLUGIN_ABI.md`](../../docs/PLUGIN_ABI.md)
- [`../../docs/PUBLIC_API.md`](../../docs/PUBLIC_API.md)
- Docs site: <https://stream-mdx.vercel.app/docs>
