# MDX and HTML in StreamMDX

## Why MDX is optional

StreamMDX treats MDX as an opt-in feature. Plain Markdown streams fast and predictably. MDX adds custom components, but requires compilation. You can enable it only where you need it:

```tsx
<StreamingMarkdown
  text={content}
  features={{ mdx: true, html: true }}
  mdxCompileMode="worker"
/>
```

If you do not need MDX, leave it off for the simplest and fastest path.

## Compile strategies

### Worker mode (default recommendation)

- all compilation happens in the worker
- no server endpoint needed
- worker and server behavior are identical

```tsx
<StreamingMarkdown mdxCompileMode="worker" />
```

### Server mode

- you host a compile endpoint (useful for stricter build control)
- the worker requests compiled output
- you must keep server and worker compile settings aligned

```tsx
<StreamingMarkdown mdxCompileMode="server" />
```

## MDX component registry

MDX components are passed separately from block overrides:

```tsx
const mdxComponents = {
  Callout: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="rounded border border-border p-4">
      <div className="font-semibold">{title}</div>
      <div className="mt-2">{children}</div>
    </div>
  ),
};

<StreamingMarkdown text={content} mdxComponents={mdxComponents} />
```

## HTML blocks

When HTML is enabled, raw HTML blocks are sanitized and rendered with a configurable allowlist. You can also swap HTML tags for your own components:

```tsx
const htmlElements = {
  blockquote: ({ children }: { children: React.ReactNode }) => (
    <blockquote className="border-l-2 border-border pl-4 text-muted-old">{children}</blockquote>
  ),
};

<StreamingMarkdown text={content} htmlElements={htmlElements} features={{ html: true }} />
```

## When to use each feature

- **Markdown only**: most content, best performance
- **HTML**: when you need raw HTML tags (tables, custom spans)
- **MDX**: when you need React components in content

## Example MDX snippet

```
<Callout title="Heads up">
  This is a custom component rendered inside the stream.
</Callout>

Here is a YouTube embed:

<YouTube videoId="dQw4w9WgXcQ" />
```

In worker mode, this compiles inside the worker and renders as soon as the block completes.

