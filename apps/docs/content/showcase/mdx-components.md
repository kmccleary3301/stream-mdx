# Custom MDX Components

This page demonstrates MDX component registration across worker/server compile paths.

## Goals

- Keep MDX rendering deterministic across `mdxCompileMode="server"` and `"worker"`.
- Register shared components once and reuse in both static and streaming routes.
- Avoid hydration drift by keeping component props serializable.

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
};

<StreamingMarkdown
  text={mdxText}
  features={{ mdx: true }}
  mdxCompileMode="server"
  mdxComponents={mdxComponents}
  worker="/workers/markdown-worker.js"
/>;
```

## MDX snippet

```mdx
<Note>Server and worker compile paths should produce the same final block tree.</Note>

<Step n={1}>Load your hosted worker.</Step>
<Step n={2}>Enable <code>features.mdx</code> and choose a compile mode.</Step>
```

## Deployment guidance

- For static docs export, compile snapshots at build time and render with `@stream-mdx/react/server`.
- For live streams, keep the same `mdxComponents` map in the client renderer.
- Add parity tests when introducing new MDX components with custom props.
