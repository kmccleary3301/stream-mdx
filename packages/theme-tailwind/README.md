# `@stream-mdx/theme-tailwind`

`@stream-mdx/theme-tailwind` is the optional Tailwind-oriented CSS baseline for StreamMDX output. It is useful when you want the renderer to drop into a Tailwind codebase with a sensible markdown/prose/styling foundation.

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

Recommended markup structure:

```tsx
import { StreamingMarkdown } from "stream-mdx";

export function Article({ content }: { content: string }) {
  return (
    <div className="prose markdown">
      <StreamingMarkdown className="markdown-v2-output" text={content} worker="/workers/markdown-worker.js" />
    </div>
  );
}
```

## What It Styles

- `.markdown-v2-output` for streaming-specific layout tweaks
- `.markdown` for markdown typography helpers
- `.prose` compatibility when used with `@tailwindcss/typography`

## Notes

- If you want full `prose` defaults, install and enable `@tailwindcss/typography`.
- The theme expects CSS variables like `--foreground` and `--border`; map them into your design system or replace them.
- StreamMDX component overrides (`components`, `inlineComponents`, `tableElements`) still work on top of the theme.

## Documentation

- [`../../docs/REACT_INTEGRATION_GUIDE.md`](../../docs/REACT_INTEGRATION_GUIDE.md)
- [`../../docs/STYLING_PARITY.md`](../../docs/STYLING_PARITY.md)
