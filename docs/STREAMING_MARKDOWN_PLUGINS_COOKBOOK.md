# StreamMDX — Plugins & Worker Customization Cookbook

_Last updated: 2025-12-17_

This cookbook focuses on the parts of the “plugins” story that are relevant to **real app integration**:

- How built-in plugin domains (tables/html/mdx/math/footnotes/callouts) are toggled.
- How the worker is configured (`docPlugins` and `contentPolicy`).
- How restricted source components differ from full MDX evaluation.
- How to opt into full MDX with an explicit trusted engine.

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
/>;
```

Notes:

- `features` configures parsing and renderer behavior.
- `contentPolicy` defaults to `"restricted"`; `features.mdx` alone does not evaluate authored source.

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
  contentPolicy: "restricted",
});
```

The hosted worker bundle includes the built-in implementations for those domains. `docPlugins` controls parsing and aggregation. `contentPolicy` defaults to `"restricted"`; worker parsing does not evaluate authored MDX. In restricted mode, host registrations are created with `defineContentComponent`; only serializable names and render conditions cross `INIT`, never validators or component functions. Native projected children remain host React nodes.

---

## 4) Full MDX for trusted source

`features.mdx` enables component syntax parsing, not automatic evaluation. Restricted source can use host `defineContentComponent` registrations in `contentComponents`. For full MDX, create an explicit engine and pass it through the React integration:

```tsx
import { StreamingMarkdown } from "stream-mdx";
import { createTrustedMdxEngine } from "@stream-mdx/react/trusted-mdx";
import { Callout } from "./Callout";

const hostWidgets = { Callout };
const mdxEngine = createTrustedMdxEngine({
  components: hostWidgets,
  imports: { "host:widgets": hostWidgets },
});

<StreamingMarkdown
  text={trustedContent}
  features={{ mdx: true }}
  contentPolicy="trusted-mdx"
  engines={{ mdx: mdxEngine }}
/>;
```

The trusted engine evaluates authored code in the host realm. Use it only for reviewed, trusted input; it is not a sandbox. See `docs/SECURITY_MODEL.md` for CSP requirements and limitations.

The explicit import map resolves authored specifiers only to supplied host bindings; no modules are fetched. Trusted evaluation runs in the host realm, requires `unsafe-eval` in `script-src`, and is not a sandbox. Native worker `FINALIZED` does not imply trusted projection or host render commit readiness. See `docs/SECURITY_MODEL.md` for the lease, stale-work, and CSP boundaries.

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

If you control the worker bundle, plugin primitives live under `@stream-mdx/plugins/document` (and native extensions via `docs/PLUGIN_ABI.md`).

---

## 7) Tree-shaking and bundle size

If you import plugin utilities in your app code, prefer subpath imports (`stream-mdx/plugins/tables`) over the root barrel (`stream-mdx/plugins`) so bundlers can exclude unused modules.

Quick sanity check:

- `npm pack --dry-run` should include only `dist/**` and no `*.map` files.
- Your app bundle should not pull worker-only dependencies into the main thread unless you imported them intentionally.

---

## 8) Troubleshooting

- **MDX renders as restricted content**: `contentPolicy` defaults to `"restricted"` and does not evaluate authored expressions. Register native source components with `defineContentComponent`; full MDX requires `engines.mdx` from `createTrustedMdxEngine`, trusted input, an explicit import map, and CSP permission for `unsafe-eval`.
- **Worker fails under strict CSP**: host the worker bundle and use `worker="/workers/markdown-worker.js"` (avoid `blob:`).
- **Tables render as plain HTML**: provide `tableElements` (or ensure your CSS covers default table classes).
- **Import errors on pnpm**: prefer `stream-mdx/plugins/*` / `stream-mdx/worker/*` / `stream-mdx/core/*` rather than importing transitive `@stream-mdx/*` deps.

