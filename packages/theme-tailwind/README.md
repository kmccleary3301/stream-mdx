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

Recommended native markup:

```tsx
import { StreamingMarkdown } from "stream-mdx";

export function Article({ content }: { content: string }) {
  return <StreamingMarkdown text={content} worker="/workers/markdown-worker.js" colorScheme="system" />;
}
```

Native output roots carry `data-stream-mdx` and `not-prose`. This gives the renderer its scoped typography and keeps enclosing Tailwind typography-plugin styles from restyling native output.


## What It Styles

- Native renderer output hooks such as `.markdown-v2-output`, `.markdown-list`, `.markdown-list-item`, `.markdown-code-block`, and `.markdown-link`
- Prose and legacy `.markdown` compatibility helpers
- Shiki light/dark foreground, background, font-style, font-weight, and text-decoration tokens

## Notes

- CSS custom properties and native output rules are scoped to `[data-stream-mdx]`; they do not change host styles outside a renderer root.
- Standalone legacy `.markdown` wrappers outside a native StreamMDX root no longer receive the theme's custom-property defaults; migrate them to `StreamingMarkdown` or `MarkdownBlocksRenderer`.
- `colorScheme` accepts `"light"`, `"dark"`, or `"system"`. An explicit value wins; `"system"` follows `prefers-color-scheme` in CSS without a JavaScript media listener. When unset, a `.dark` ancestor retains the existing class-based behavior.
- Hosts using another theme mechanism should set `colorScheme` on the StreamMDX root.
- The theme expects host design tokens like `--foreground` and `--border`; map them into your design system or replace them.
- Shiki's dual-theme variables cover foreground, background, font style, font weight, and text decoration for both light and dark tokens.
- StreamMDX component overrides (`components`, `inlineComponents`, `tableElements`) still work on top of the theme.

## Documentation

- [`../../docs/REACT_INTEGRATION_GUIDE.md`](../../docs/REACT_INTEGRATION_GUIDE.md)
- [`../../docs/STYLING_PARITY.md`](../../docs/STYLING_PARITY.md)
