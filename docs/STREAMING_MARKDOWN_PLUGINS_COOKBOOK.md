# StreamMDX — Plugins & Worker Customization Cookbook

_Last updated: 2025-12-17_

This cookbook focuses on the parts of the “plugins” story that are relevant to **real app integration**:

- How built-in plugin domains (tables/html/mdx/math/footnotes/callouts) are toggled.
- How the worker is configured (`docPlugins`, `mdxCompileMode`).
- How to keep MDX compilation parity (server vs worker).
- Where “custom plugins” actually live in the architecture (worker bundle customization).

If you are looking for the top-level React API, start with `docs/PUBLIC_API.md` and `docs/REACT_INTEGRATION_GUIDE.md`.

---

## 1) Package overview

StreamMDX publishes plugin primitives under:

- `@stream-mdx/plugins` (scoped)
- `stream-mdx/plugins` (convenience wrapper)

Most apps do **not** need to import plugin registries directly. Start with `<StreamingMarkdown features={...} />`.

When you *do* need the plugin primitives (custom worker bundles, custom tokenizers/matchers), import subpaths:

- `stream-mdx/plugins/document`
- `stream-mdx/plugins/tables`
- `stream-mdx/plugins/html`
- `stream-mdx/plugins/mdx`
- `stream-mdx/plugins/math`
- `stream-mdx/plugins/math/renderer`

Scoped equivalents are available at `@stream-mdx/plugins/*`.

---

## 2) Built-in “plugin domains” (most common path)

Built-in capabilities are toggled via `features` on `<StreamingMarkdown />`:

```tsx
import { StreamingMarkdown } from "stream-mdx";

<StreamingMarkdown
  text={text}
  worker="/workers/markdown-worker.js"
  features={{
    tables: true,
    html: true,
    mdx: true,
    math: true,
    footnotes: true,
    callouts: false,
  }}
  mdxCompileMode="worker"
/>;
```

Notes:

- `features` configures both the worker and the renderer.
- `mdxCompileMode` enables MDX compilation/hydration and selects `"server"` vs `"worker"`.

---

## 3) Manual worker initialization (`docPlugins`)

If you are not using `<StreamingMarkdown />` (e.g. you build a custom renderer loop), initialize the worker with matching flags:

```ts
worker.postMessage({
  type: "INIT",
  initialContent: "",
  prewarmLangs: ["typescript", "bash"],
  docPlugins: {
    footnotes: true,
    html: true,
    mdx: true,
    tables: true,
    callouts: false,
    math: true,
  },
  mdx: { compileMode: "worker" },
});
```

The hosted worker bundle already includes StreamMDX’s built-in implementations for those domains. `docPlugins` controls what is enabled during parsing/aggregation.

---

## 4) MDX parity (server vs worker)

StreamMDX is designed to keep server and worker compilation **equivalent**. For server compilation, use:

```ts
import { compileMdxContent } from "stream-mdx/worker/mdx-compile";
```

This is the same pipeline used by the worker compilation path (remark/rehype stack + `@mdx-js/mdx` output as `function-body`).

### Next.js route example

```ts
import { NextRequest, NextResponse } from "next/server";
import { compileMdxContent } from "stream-mdx/worker/mdx-compile";

export async function POST(request: NextRequest) {
  const { content, blockId } = await request.json();
  const compiled = await compileMdxContent(content);
  return NextResponse.json({
    id: blockId,
    code: compiled.code,
    dependencies: compiled.dependencies,
  });
}
```

---

## 5) Tables (Shadcn wrappers)

Tables are rendered via the table “elements” map, not by overriding raw HTML tags:

```tsx
import { StreamingMarkdown } from "stream-mdx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const tableElements = {
  Table,
  Thead: TableHeader,
  Tbody: TableBody,
  Tr: TableRow,
  Th: TableHead,
  Td: TableCell,
};

<StreamingMarkdown text={text} tableElements={tableElements} />;
```

---

## 6) “Custom plugins” (custom syntax)

Custom syntax (citations, mentions, bespoke tags) is a **worker-side concern**. The default hosted worker bundle only knows about built-in domains.

The recommended approach is:

1. Build a custom worker bundle that registers your tokenizers/matchers.
2. Host it and pass it via the `worker` prop.
3. Render any emitted nodes via `inlineComponents` / `components`.

If you control the worker bundle, plugin primitives live under `@stream-mdx/plugins/base` and `@stream-mdx/plugins/registry`.

---

## 7) Tree-shaking and bundle size

If you import plugin utilities in your app code, prefer subpath imports (`stream-mdx/plugins/math`) over the root barrel (`stream-mdx/plugins`) so bundlers can exclude unused modules.

Quick sanity check:

- `npm pack --dry-run` should include only `dist/**` and no `*.map` files.
- Your app bundle should not pull worker-only dependencies into the main thread unless you imported them intentionally.

---

## 8) Troubleshooting

- **MDX blocks show raw content**: set `features={{ mdx: true }}` and `mdxCompileMode="worker"` (or implement `/api/mdx-compile-v2` for `"server"`).
- **Worker fails under strict CSP**: host the worker bundle and use `worker="/workers/markdown-worker.js"` (avoid `blob:`).
- **Tables render as plain HTML**: provide `tableElements` (or ensure your CSS covers default table classes).
- **Import errors on pnpm**: prefer `stream-mdx/plugins/*` / `stream-mdx/worker/*` / `stream-mdx/core/*` rather than importing transitive `@stream-mdx/*` deps.

