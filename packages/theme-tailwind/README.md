# `@stream-mdx/theme-tailwind`

`@stream-mdx/theme-tailwind` is the optional Tailwind-oriented CSS baseline for StreamMDX output. It is useful when you want the renderer to drop into a Tailwind codebase with a markdown/prose foundation that you can adapt to your own design system.

## Install

```bash
npm install @stream-mdx/theme-tailwind
```

## Available CSS Entrypoints

| Import | Notes |
| --- | --- |
| `@stream-mdx/theme-tailwind/theme.css` | Main theme entrypoint |
| `@stream-mdx/theme-tailwind/styles.css` | Alternate packaged stylesheet export |

## Usage

Import after your Tailwind directives:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@import "@stream-mdx/theme-tailwind/theme.css";
```

Recommended markup structure for new integrations:

```tsx
import { StreamingMarkdown } from "stream-mdx";

export function Article({ content }: { content: string }) {
  return (
    <div className="prose">
      <StreamingMarkdown text={content} worker="/workers/markdown-worker.js" />
    </div>
  );
}
```

## What It Styles

- Renderer output hooks such as `.markdown-v2-output`, `.markdown-list`, `.markdown-list-item`, `.markdown-code-block`, and `.markdown-link`
- Prose compatibility when used with `@tailwindcss/typography`
- Legacy `.markdown` compatibility for applications that already adopted the older wrapper pattern

## Notes

- Prefer one prose owner around rendered output. Do not stack `.prose markdown` in new code unless you are maintaining an older integration.
- If you want full `prose` defaults, install and enable `@tailwindcss/typography`.
- The theme expects CSS variables like `--foreground` and `--border`; map them into your design system or replace them.
- StreamMDX component overrides (`components`, `inlineComponents`, `tableElements`) still work on top of the theme.

## Documentation

- [`../../docs/REACT_INTEGRATION_GUIDE.md`](../../docs/REACT_INTEGRATION_GUIDE.md)
- [`../../docs/STYLING_PARITY.md`](../../docs/STYLING_PARITY.md)
