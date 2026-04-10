# HTML Overrides (ShadCN)

This showcase demonstrates mapping raw HTML and standard markdown tags to design-system components while keeping StreamMDX's patch model and deterministic output intact. The important point is that you can adopt your design system without forking parser behavior.

## Why this matters

- You can keep the default worker/parser behavior and only swap the render layer.
- Streaming performance remains stable because overrides run after block parsing.
- This is the safest path for design-system alignment without forking parser behavior.
- It keeps your docs/demo surface aligned with the same renderer logic used in production.

## Example: map table tags to ShadCN wrappers

```tsx
import type { TableElements } from "stream-mdx";

const tableElements: Partial<TableElements> = {
  table: ({ className, ...props }) => (
    <div className="overflow-x-auto rounded-md border border-border/60">
      <table className={`w-full text-sm ${className ?? ""}`} {...props} />
    </div>
  ),
  th: ({ className, ...props }) => <th className={`bg-muted/40 text-left font-semibold ${className ?? ""}`} {...props} />,
  td: ({ className, ...props }) => <td className={`align-top ${className ?? ""}`} {...props} />,
};

<StreamingMarkdown text={markdown} tableElements={tableElements} worker="/workers/markdown-worker.js" />;
```

## Example: map raw HTML tags

```tsx
import type { HtmlElements } from "stream-mdx";

const htmlElements: Partial<HtmlElements> = {
  blockquote: ({ className, ...props }) => (
    <blockquote className={`border-l-4 border-foreground/30 bg-muted/30 px-4 py-2 italic ${className ?? ""}`} {...props} />
  ),
  pre: ({ className, ...props }) => (
    <div className="overflow-x-auto rounded-md border border-border/60">
      <pre className={className} {...props} />
    </div>
  ),
};

<StreamingMarkdown text={markdown} features={{ html: true }} htmlElements={htmlElements} worker="/workers/markdown-worker.js" />;
```

## Rendered HTML samples

<blockquote>
  This blockquote is emitted from raw HTML content and can be restyled safely via <code>htmlElements.blockquote</code>.
</blockquote>

<table>
  <thead>
    <tr><th>Scenario</th><th>Expected behavior</th></tr>
  </thead>
  <tbody>
    <tr><td>Wide table</td><td>Horizontal overflow wrapper prevents layout shift.</td></tr>
    <tr><td>Streaming updates</td><td>Only tail patches update; prior rows remain stable.</td></tr>
  </tbody>
</table>

## Guardrails

- Keep sanitization enabled for untrusted HTML.
- Use overflow wrappers for `table`, `pre`, and block math renders.
- Avoid adding heavy client hooks in overrides unless deferred.

## When not to use overrides

Do **not** reach for `htmlElements` or `tableElements` when the thing you want is actually parser behavior.

Use overrides when:

- the semantics are already correct
- you only need different presentation
- the design system requires wrappers, spacing, or custom component shells

Reach for plugins or worker-side extension points when you need:

- new syntax
- new semantic nodes
- custom anticipation behavior
- domain-specific parsing

## Next steps

- API details: [Public API](/docs/public-api)
- MDX and HTML guide: [MDX and HTML](/docs/guides/mdx-and-html)
- Showcase index: [Showcase](/showcase)
