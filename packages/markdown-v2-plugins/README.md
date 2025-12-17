# `@stream-mdx/plugins`

Plugin primitives and registries used by StreamMDX.

Most app consumers **do not** need to import this package directly. Start with:

- `stream-mdx` (recommended)
- `docs/GETTING_STARTED.md`

Use `@stream-mdx/plugins` when you are:

- building a **custom worker bundle** (custom tokenizers, extra document plugins, custom streaming matchers)
- integrating StreamMDX into another library and you want explicit control over the worker-side feature set

## Install

```bash
npm install @stream-mdx/plugins
```

## Entry points

- `@stream-mdx/plugins` (root)
- `@stream-mdx/plugins/registry`
- `@stream-mdx/plugins/base`
- `@stream-mdx/plugins/document`
- `@stream-mdx/plugins/tables`
- `@stream-mdx/plugins/html`
- `@stream-mdx/plugins/math`
- `@stream-mdx/plugins/math/renderer`
- `@stream-mdx/plugins/mdx`
- `@stream-mdx/plugins/footnotes`
- `@stream-mdx/plugins/callouts`

## Important note about “plugins”

The primary way to enable/disable capabilities in StreamMDX is the `features` prop on `<StreamingMarkdown />`:

```tsx
<StreamingMarkdown features={{ tables: true, html: true, math: true, mdx: true }} />
```

If you need **custom syntax**, you generally need a **custom worker bundle** rather than “passing plugins as a prop”.

## Docs

- Plugins & worker cookbook: `docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`
- Public API: `docs/PUBLIC_API.md`
