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
import { STREAM_MDX_SCHEMA_VERSION } from "stream-mdx/core";

worker.postMessage({
  type: "INIT",
  schemaVersion: STREAM_MDX_SCHEMA_VERSION,
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

## 5) Table presentations

Tables use semantic presentation keys instead of a separate element map. Wrap the native table with `components.table` and style rows or cells with `components["table-row"]` and `components["table-cell"]`.

```tsx
import { StreamingMarkdown, type NodeViewProps } from "stream-mdx";

const tablePresentations = {
  table: {
    wrapper: ({ children }: NodeViewProps) => (
      <div className="my-4 overflow-x-auto rounded-md border">{children}</div>
    ),
  },
  "table-row": {
    props: { className: "border-b last:border-0" },
  },
  "table-cell": {
    props: { className: "px-3 py-2 text-left" },
  },
};

<StreamingMarkdown text={text} components={tablePresentations} />;
```

---

## 6) “Custom plugins” (custom syntax)

Use serializable `syntax` rules for supported inline patterns. Custom tokenizers and document plugins require a custom worker bundle; the default hosted worker only includes built-in domains.

1. Add supported inline rules through `syntax`, or register custom tokenizers and document plugins in a custom worker.
2. Host the custom worker bundle and pass it via the `worker` prop.
3. Render emitted inline extension nodes through `components["extension:<name>"]`, using a wrapper or headless view.

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
- **Tables render as plain HTML**: style native tables with `components.table`, `components["table-row"]`, and `components["table-cell"]`, or ensure your CSS covers the default table classes.
- **Import errors on pnpm**: prefer `stream-mdx/plugins/*` / `stream-mdx/worker/*` / `stream-mdx/core/*` rather than importing transitive `@stream-mdx/*` deps.

