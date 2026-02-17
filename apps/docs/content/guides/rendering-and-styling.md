# Rendering and Styling

## The render surface

StreamMDX exposes two major customization surfaces:

- `components` (block-level rendering)
- `inlineComponents` (inline rendering)

You can override individual blocks without losing incremental rendering. This is how you wrap code blocks, tables, or math without breaking the stream.

## Block-level overrides

```tsx
import { StreamingMarkdown } from "stream-mdx";
import { ScrollAreaHorizontal } from "@/components/ui/scroll-area";

const components = {
  code: ({ html }) => (
    <pre className="not-prose rounded-lg border border-border">
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

This wraps the existing optimized code rendering inside a scroll container while keeping the patch pipeline intact.

## Inline overrides

Inline overrides let you swap tags for specific inline nodes:

```tsx
const inlineComponents = {
  code: ({ text }: { text: string }) => (
    <code className="inline-code rounded bg-muted px-1">{text}</code>
  ),
  link: ({ href, children }: { href?: string; children: React.ReactNode }) => (
    <a className="markdown-link underline" href={href} target={href?.startsWith("http") ? "_blank" : undefined}>
      {children}
    </a>
  ),
};

<StreamingMarkdown text={content} inlineComponents={inlineComponents} />
```

## Tables with ShadCN

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

<StreamingMarkdown text={content} tableElements={tableElements} />
```

This swaps table tags without changing how the renderer schedules updates.

## HTML overrides

When `features.html` is enabled, HTML blocks can be mapped onto custom components:

```tsx
const htmlElements = {
  table: ({ children }: { children: React.ReactNode }) => (
    <div className="rounded border border-border overflow-x-auto">{children}</div>
  ),
};

<StreamingMarkdown text={content} htmlElements={htmlElements} features={{ html: true }} />
```

## HTML overrides (ShadCN-style wrappers)

If your content includes raw HTML, you can wrap it with ShadCN primitives while keeping streaming intact:

```tsx
const htmlElements = {
  table: ({ children }: { children: React.ReactNode }) => (
    <div className="rounded-lg border border-border overflow-x-auto">{children}</div>
  ),
  blockquote: ({ children }: { children: React.ReactNode }) => (
    <blockquote className="border-l-2 border-border pl-4 text-muted-foreground">{children}</blockquote>
  ),
};

<StreamingMarkdown text={content} htmlElements={htmlElements} features={{ html: true }} />
```

## Typography and spacing

The docs site uses two layers of styles:

- `.markdown-v2-output` for streaming-specific tweaks
- `.markdown` and `.prose` for base typography

You can disable or replace these styles in your own app. The component itself does not inject CSS, so you control the look completely.

## Optional Tailwind theme package

If you want the docs styling without copying CSS, install the optional theme package:

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

The theme ships `.markdown-v2-output`, `.markdown`, and `.prose` helpers. Use `@tailwindcss/typography` if you want the `prose` base styles.

## Recommended structure

```tsx
<div className="prose markdown">
  <StreamingMarkdown className="markdown-v2-output" text={content} />
</div>
```

This pattern keeps markdown typography consistent while still using the streaming renderer.
