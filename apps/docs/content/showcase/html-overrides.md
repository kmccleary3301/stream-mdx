# HTML Overrides (ShadCN)

This showcase demonstrates mapping raw HTML and standard markdown tags to design-system components while keeping StreamMDX's patch model and deterministic output intact. The important point is that you can adopt your design system without forking parser behavior.

## Why this matters

- You can keep the default worker/parser behavior and only swap the render layer.
- Streaming performance remains stable because overrides run after block parsing.
- This is the safest path for design-system alignment without forking parser behavior.
- It keeps your docs/demo surface aligned with the same renderer logic used in production.

## Example: wrap Markdown tables with ShadCN

The `table` presentation wraps the native block, keeping its row structure and virtualization intact:

```tsx
import { StreamingMarkdown, type NodeViewProps } from "stream-mdx";

function ShadcnTablePresentation({ children }: NodeViewProps) {
  return <div className="overflow-x-auto rounded-md border border-border/60">{children}</div>;
}

<StreamingMarkdown
  text={markdown}
  components={{ table: { wrapper: ShadcnTablePresentation } }}
  worker="/workers/markdown-worker.js"
/>;
```

## Example: decorate raw HTML tags

```tsx
const components = {
  "html:blockquote": {
    props: { className: "border-l-4 border-foreground/30 bg-muted/30 px-4 py-2 italic" },
  },
  "html:pre": {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <div className="overflow-x-auto rounded-md border border-border/60">{children}</div>
    ),
  },
};

<StreamingMarkdown text={markdown} features={{ html: true }} components={components} worker="/workers/markdown-worker.js" />;
```

## Rendered HTML samples

<blockquote>
  This blockquote is emitted from raw HTML content and can be restyled safely via <code>components["html:blockquote"]</code>.
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

Do **not** reach for `components.table` or `components["html:<tag>"]` when the thing you want is actually parser behavior.

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
