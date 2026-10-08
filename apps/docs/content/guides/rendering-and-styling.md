# Rendering and Styling

## The render surface

StreamMDX exposes two major customization surfaces:

- `components` for block-level rendering
- `inlineComponents` for inline rendering

Override the semantic piece you need without taking over the stream scheduler. Code blocks, tables, math, links, callouts, and MDX islands can all be customized while preserving incremental rendering.

## Default styling contract

The renderer emits semantic markup and stable renderer classes such as `.markdown-v2-output`, `.markdown-list`, `.markdown-list-item`, `.markdown-code-block`, and `.markdown-link`. It does not inject CSS at runtime.

In this docs app, rendered prose is governed by one styling boundary:

```tsx
<div className="prose">
  <StreamingMarkdown text={content} worker="/workers/markdown-worker.js" />
</div>
```

The `.prose` parent owns the typography context. The `.markdown-v2-output` class is the renderer output hook used by the app stylesheet, not a second app-shell/card styling layer. Do not stack a legacy `.markdown` wrapper in new docs-app code.

## Block-level overrides

```tsx
import { StreamingMarkdown } from "stream-mdx";
import { ScrollAreaHorizontal } from "@/components/ui/scroll-area";

const components = {
  code: ({ html }) => (
    <pre className="not-prose docs-code-block">
      <ScrollAreaHorizontal className="min-w-auto">
        <div className="min-w-max p-4" dangerouslySetInnerHTML={{ __html: html }} />
      </ScrollAreaHorizontal>
    </pre>
  ),
};

export function StyledCode({ text }: { text: string }) {
  return <StreamingMarkdown text={text} components={components} worker="/workers/markdown-worker.js" />;
}
```

This wraps the optimized code rendering inside a horizontal scroll container while keeping the patch pipeline intact. The wrapper class is intentionally app-owned; do not treat it as a default visual prescription for other projects.

## Code highlighting themes

StreamMDX provides end-to-end configurable Shiki themes for code blocks. Pass any Shiki bundled theme name for light and dark modes:

```tsx
<StreamingMarkdown
  text={content}
  themes={{ light: "min-light", dark: "nord" }}
/>
```

Themes are loaded on demand into the worker highlighter singleton, and cache partitions prevent cross-contamination between engines with different themes. Unknown or invalid theme names report an initialization error through the standard error callback and fall back safely to default GitHub themes.

When using static snapshot compilation directly:

```ts
import { compileMarkdownSnapshotDirect } from "@stream-mdx/worker/direct";

const result = await compileMarkdownSnapshotDirect({
  text,
  init: {
    themes: { light: "vitesse-light", dark: "vitesse-dark" },
  },
});
```
## Inline overrides

Inline overrides let you swap tags for specific inline nodes:

```tsx
const inlineComponents = {
  code: ({ text }: { text: string }) => <code className="inline-code">{text}</code>,
  link: ({ href, children }: { href?: string; children: React.ReactNode }) => (
    <a className="markdown-link" href={href} target={href?.startsWith("http") ? "_blank" : undefined}>
      {children}
    </a>
  ),
};

<StreamingMarkdown text={content} inlineComponents={inlineComponents} />;
```

Use inline overrides to preserve the semantic role while delegating the final visual treatment to your prose stylesheet.

## Tables

Table rendering can use custom elements:

```tsx
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const tableElements = {
  Table,
  Thead: TableHeader,
  Tbody: TableBody,
  Tr: TableRow,
  Th: TableHead,
  Td: TableCell,
};

<StreamingMarkdown text={content} tableElements={tableElements} />;
```

This swaps table tags without changing how the renderer schedules updates.

## HTML overrides

When `features.html` is enabled, HTML blocks can be mapped onto custom components:

```tsx
const htmlElements = {
  table: ({ children }: { children: React.ReactNode }) => <div className="not-prose overflow-x-auto">{children}</div>,
  blockquote: ({ children }: { children: React.ReactNode }) => <blockquote>{children}</blockquote>,
};

<StreamingMarkdown text={content} htmlElements={htmlElements} features={{ html: true }} />;
```

HTML overrides are a semantic integration point. Add borders, radius, shadows, or branded chrome only when they are part of your application design system, not as renderer defaults.

## Optional Tailwind theme package

If you want a packaged Tailwind-oriented baseline, install the optional theme package:

```bash
npm install @stream-mdx/theme-tailwind
```

Then import the stylesheet after your Tailwind directives:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@import "@stream-mdx/theme-tailwind/theme.css";
```

Recommended structure for new integrations:

```tsx
<div className="prose">
  <StreamingMarkdown text={content} worker="/workers/markdown-worker.js" />
</div>
```

The package keeps some legacy compatibility selectors for consumers that already used `.markdown`, but new integrations should use a single prose owner and treat renderer classes as output hooks.
