# Rendering and Styling

## The render surface

StreamMDX exposes two major customization surfaces:

- `components` for block, inline, and HTML-node presentation wrappers or views

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
import { StreamingMarkdown, type NodeViewProps } from "stream-mdx";
import { ScrollAreaHorizontal } from "@/components/ui/scroll-area";

function CodePresentation({ children }: NodeViewProps) {
  return (
    <ScrollAreaHorizontal className="min-w-auto">
      <div className="not-prose docs-code-block min-w-max p-4">{children}</div>
    </ScrollAreaHorizontal>
  );
}

const components = {
  code: { wrapper: CodePresentation },
};

export function StyledCode({ text }: { text: string }) {
  return <StreamingMarkdown text={text} components={components} worker="/workers/markdown-worker.js" />;
}
```

This wraps the optimized code rendering inside a horizontal scroll container while preserving the prepared native code view and patch pipeline. The wrapper class is app-owned; it is not a default visual prescription for other projects.

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

Inline presentations use keys such as `"inline:code"` and receive the parsed node in a headless `view`:

```tsx
import { StreamingMarkdown, type InlineNodeViewProps } from "stream-mdx";

const components = {
  "inline:code": {
    view: ({ node }: InlineNodeViewProps) =>
      node.kind === "code" ? <code className="inline-code">{node.text}</code> : null,
  },
  "inline:link": {
    view: ({ node, children }: InlineNodeViewProps) =>
      node.kind === "link" ? (
        <a className="markdown-link" href={node.href} target={node.href?.startsWith("http") ? "_blank" : undefined}>
          {children}
        </a>
      ) : children,
  },
};

<StreamingMarkdown text={content} components={components} />;
```

Use inline presentations to preserve the semantic role while delegating visual treatment to your prose stylesheet.

## Tables

Wrap the native table block to add design-system overflow and spacing without replacing its rows or viewport:

```tsx
import { StreamingMarkdown, type NodeViewProps } from "stream-mdx";

function TablePresentation({ children }: NodeViewProps) {
  return <div className="my-4 overflow-x-auto rounded-md border border-border/60">{children}</div>;
}

<StreamingMarkdown text={content} components={{ table: { wrapper: TablePresentation } }} />;
```

The renderer retains native table rows, cells, controls, and virtualization.
## Block controls (copy and download)

Enable copy and download buttons for code blocks, tables, and Mermaid diagrams using the opt-in `controls` prop:

```tsx
<StreamingMarkdown
  text={content}
  controls={{
    code: { copy: true, download: true },
    table: { copy: true, download: ["csv", "tsv", "markdown"] },
    mermaid: { copy: true },
    labels: {
      copy: "Copy code",
      downloadCsv: "Download CSV",
    },
  }}
/>
```

Controls are disabled (`false`) by default so existing rendered output and snapshots remain unchanged. When enabled:
- Code blocks provide a copy button that extracts the raw authored code text (not highlighted HTML) and a download button that saves `snippet.<ext>` matching the authored language.
- Tables provide copy as TSV or Markdown, and download as CSV, TSV, or Markdown (enabled once the table block is finalized).
- All buttons are real `<button type="button">` elements with accessible labels and `data-stream-mdx-control` attributes for styling.

## Animated streaming text (`animated`)

Opt in to smooth, per-word or per-character fade and slide transitions as text streams into non-finalized blocks:

```tsx
import { STREAM_MDX_ANIMATION_CSS, StreamingMarkdown } from "@stream-mdx/react";

// 1. Include default animation keyframes in your document/stylesheet
<style dangerouslySetInnerHTML={{ __html: STREAM_MDX_ANIMATION_CSS }} />

// 2. Enable animation on the streaming markdown component
<StreamingMarkdown
  stream={stream}
  animated={{
    animation: "fadeIn", // "fadeIn" | "blurIn" | "slideUp" | custom keyframe name
    duration: 150,      // ms
    easing: "ease-out",
    sep: "word",        // "word" | "char"
    stagger: 20,        // ms delay between newly mounted segments
    maxBacklogMs: 320,  // ms maximum delay cap
  }}
/>
```

When `animated` is `true` or an configuration object:
- Non-finalized text renders as stable keyed `<span>` elements with class `stream-mdx-anim` and CSS variables `--sm-anim-duration`, `--sm-anim-easing`, and `--sm-anim-delay`.
- As new tokens stream in, already-mounted segments preserve their DOM identity and stay at their final resting state without restarting animation.
- When a block finalizes, or during server-side and static renders, content renders as plain text without animation wrapper elements.
- Reduced-motion preferences (`prefers-reduced-motion: reduce`) are honored automatically in `STREAM_MDX_ANIMATION_CSS`.


## HTML overrides

When `features.html` is enabled, HTML tags can be decorated through semantic node presentations:

```tsx
const components = {
  "html:table": {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <div className="not-prose overflow-x-auto">{children}</div>
    ),
  },
  "html:blockquote": {
    props: { className: "border-l-4 border-foreground/30 bg-muted/30 px-4 py-2 italic" },
  },
};

<StreamingMarkdown text={content} components={components} features={{ html: true }} />;
```

HTML presentations receive sanitized native elements and cannot allow a forbidden tag or attribute. Add borders, radius, shadows, or branded chrome only when they are part of your application design system.

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
