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
| `@stream-mdx/plugins/document` | `DocumentPlugin`, `DocumentContext`, `DocumentContribution`, and `DocumentPluginRegistry` |
| `@stream-mdx/plugins/tables` | Table plugin |
| `@stream-mdx/plugins/html` | HTML plugin |
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
import type { DocumentPlugin } from "@stream-mdx/plugins/document";
import { serveMarkdownWorker } from "@stream-mdx/worker/engine";

const headingMetadata: DocumentPlugin = {
  name: "heading-metadata",
  process(ctx) {
    for (const block of ctx.blocks) {
      if (block.type === "heading") {
        block.payload.meta = { ...block.payload.meta, documentPlugin: "heading-metadata" };
      }
    }
    return undefined;
  },
};

// Bundle this as a worker entry, not as application UI code.
serveMarkdownWorker({ extensions: { documentPlugins: [headingMetadata] } });
```

Native functions belong in the custom worker bundle or in `createInlineEngineWorker({ extensions })`. They are not serializable `INIT` settings. Use the UI `syntax` prop for serializable inline regex rules. The [plugin ABI](../../docs/PLUGIN_ABI.md#3-custom-bundled-worker-entry) includes a complete worker entry with native Lezer markdown/inline extensions and its build command.

## When To Reach For This Package

- You are composing your own worker init/plugin preset.
- You need custom syntax or custom matcher behavior.
- You are integrating StreamMDX into a library/framework and want explicit worker-side configuration.

## Documentation

- [`../../docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`](../../docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md)
- [`../../docs/PLUGIN_ABI.md`](../../docs/PLUGIN_ABI.md)
- [`../../docs/PUBLIC_API.md`](../../docs/PUBLIC_API.md)
- Docs site: <https://stream-mdx.vercel.app/docs>
