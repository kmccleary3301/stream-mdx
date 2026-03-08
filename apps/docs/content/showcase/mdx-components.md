# Custom MDX Components

This showcase documents a deterministic MDX component strategy that works for both static docs and live streaming routes.

## Design goals

- Keep worker and server compile output semantically equivalent.
- Register one shared component map and reuse it everywhere.
- Keep component props serializable to avoid hydration mismatches.

## Shared component map

```tsx
const mdxComponents = {
  Note: ({ children }: { children: React.ReactNode }) => (
    <aside className="rounded-md border border-border/60 bg-muted/30 px-4 py-3 text-sm">{children}</aside>
  ),
  Step: ({ n, children }: { n: number; children: React.ReactNode }) => (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 rounded-full bg-foreground/10 px-2 py-0.5 text-xs font-semibold">{n}</span>
      <div>{children}</div>
    </div>
  ),
  ApiBadge: ({ stage }: { stage: "stable" | "beta" }) => (
    <span className="rounded border border-border/60 bg-background px-2 py-0.5 text-xs">{stage}</span>
  ),
};
```

## Runtime usage

```tsx
<StreamingMarkdown
  text={mdxText}
  worker="/workers/markdown-worker.js"
  mdxCompileMode="worker"
  features={{ mdx: true, html: true, tables: true, math: true }}
  mdxComponents={mdxComponents}
/>;
```

## Static usage

For static docs export, compile snapshots during build and render with the same component map.

```tsx
<MarkdownBlocksRenderer
  blocks={snapshot.blocks}
  componentRegistry={registryWith(mdxComponents)}
/>
```

## Example MDX authoring

```mdx
<Note>Server and worker compile paths should produce the same final block tree.</Note>

<Step n={1}>Load your hosted worker.</Step>
<Step n={2}>Enable <code>features.mdx</code> and choose a compile mode.</Step>
<ApiBadge stage="stable" />
```

## Guardrails

- Avoid time-based or random rendering in MDX components.
- Do not access browser-only globals during server/static rendering.
- Keep expensive components lazy or behind explicit toggles.
- Add a parity snapshot before publishing a new shared component.

## Common pitfalls

- **Non-serializable props** (`Map`, `Date`, class instances) break deterministic output.
- **Direct DOM mutation** in MDX components causes divergence during stream updates.
- **Theme-dependent side effects** without stable defaults can drift between server and client.

## Next steps

- Deep integration: [MDX and HTML in StreamMDX](/docs/guides/mdx-and-html)
- API details: [Public API](/docs/public-api)
- Validation: [Testing and baselines](/docs/guides/testing-and-baselines)
