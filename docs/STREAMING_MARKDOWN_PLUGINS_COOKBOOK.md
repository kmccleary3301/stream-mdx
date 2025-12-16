# Streaming Markdown V2 — Plugin Cookbook

_Last updated: 2025-11-07_

This cookbook explains how to consume the `@stream-mdx/plugins` package, wire individual plugins into the worker/renderer pipeline, and verify tree-shaking so downstream bundles only pay for the features they enable. Use it alongside `docs/STREAMING_MARKDOWN_V2_STATUS.md` for architecture details.

---

## 1. Package overview

- **Entry point:** `@stream-mdx/plugins`
- **Sub-path exports:** `@stream-mdx/plugins/{callouts,document,footnotes,html,math,math/renderer,mdx,tables}`
- **Peer dependencies:** `react >= 18.2`, `@stream-mdx/react`
- **Build:** `npm run markdown-v2:build:plugins` (tsup outputs ESM, CJS, and d.ts artifacts under `packages/markdown-v2-plugins/dist/`)

Because each plugin lives under its own sub-path, bundlers can tree-shake unused features. After running the build command above you should see per-plugin bundles inside `packages/markdown-v2-plugins/dist/plugins/*`.

---

## 2. Wiring plugins into `<StreamingMarkdown>`

```ts
import { useMemo } from "react";
import { StreamingMarkdown } from "@stream-mdx/react";
import {
  createMathPlugin,
  createMdxPlugin,
  createTablePlugin,
  defaultPluginRegistry,
} from "@stream-mdx/plugins";

export function StreamingArticle({ stream }: { stream: AsyncIterable<string> }) {
  const plugins = useMemo(() => {
    const registry = defaultPluginRegistry();
    registry.use(createMathPlugin());
    registry.use(createMdxPlugin({ allowHTML: true }));
    registry.use(createTablePlugin());
    return registry;
  }, []);

  return (
    <StreamingMarkdown
      stream={stream}
      features={{
        math: true,
        mdx: true,
        tables: true,
        html: true,
      }}
      onMetrics={(metrics) => console.info("flush", metrics)}
    />
  );
}
```

Worker-side consumers should mirror the same registry when instantiating `MarkdownRenderer` or the worker bundle. Each plugin exposes deterministic hooks so the worker and React renderer stay in sync.

---

## 3. MDX hydration checklist

| Step | Description | Source |
| --- | --- | --- |
| 1 | Import `createMdxPlugin` from `@stream-mdx/plugins/mdx`. | `packages/markdown-v2-plugins/src/plugins/mdx` |
| 2 | Pass `{ compileStrategy: "server" | "worker" }` via `<StreamingMarkdown mdxCompileMode>` or `RendererConfig.mdx`. | `packages/markdown-v2-react/src/streaming-markdown.tsx` |
| 3 | Register components with `@stream-mdx/react/mdx-client`. | `packages/markdown-v2-react/src/mdx-client.ts` |
| 4 | Surface status badges via `data-mdx-status` (already in the demo). | `components/screens/streaming-markdown-demo-v2/index.tsx` |

**Quick smoke:** run `/examples/streaming`, toggle the MDX compilation dropdown, and confirm `MDX pending…` never persists once the worker completes.

---

## 4. Math / KaTeX integration

1. Enable the feature flag: `<StreamingMarkdown features={{ math: true }} />`.
2. Import helpers:

```ts
import {
  createMathPlugin,
  MathRenderer,
  MathInlineRenderer,
  MathDisplayRenderer,
} from "@stream-mdx/plugins/math";
```

3. Provide KaTeX bindings if desired by overriding the renderer exports (e.g., `MathRenderer` that calls your KaTeX runtime).
4. The worker will respect protected math ranges so MDX detection never claims brace-heavy expressions.

**Verification:** `npm run markdown-v2:test:snippets` includes math-heavy fixtures; the analyzer will emit warnings if math placeholders leak into the DOM.

---

## 5. Math + MDX worker/renderer registration

MDX detection relies on the math plugin’s protected-range metadata so it can distinguish `<Component />` syntax from inline TeX. Keep the worker and renderer in sync whenever you enable either feature.

1. **React side (`<StreamingMarkdown />` or `MarkdownRenderer`).**

```tsx
import { StreamingMarkdown } from "@stream-mdx/react";

<StreamingMarkdown
  text={text}
  features={{ math: true, mdx: true, html: true }}
  mdxCompileMode="worker"
/>;
```

`features` toggles the worker doc plugins under the hood, so this is everything you need when you rely on the packaged component.

2. **Manual worker orchestration.** When you spawn a worker yourself (SSR pools, tests), forward the same flags via `docPlugins`:

```ts
const worker = new Worker(new URL("./markdown-worker.js", import.meta.url), { type: "module" });
worker.postMessage({
  type: "INIT",
  docPlugins: { math: true, mdx: true, html: true, tables: true },
  mdx: { compileMode: "worker" },
});
```

Register math **before** MDX if you wire plugins manually (`globalDocumentPluginRegistry.register(MathPlugin); register(MDXDetectionPlugin);`). This order preserves math-protected ranges so `<Callout>$E=mc^2$</Callout>` never gets double-processed.

3. **Verification.** The regression suite now includes:

- `packages/markdown-v2-react/__tests__/renderer-plugin-forwarding.test.ts` – proves feature flags reach the worker `INIT` message.
- `packages/markdown-v2-worker/__tests__/worker-mdx-math-registration.test.ts` – asserts MDX blocks and inline math survive the same snippet.

If either side forgets to enable the matching plugin, these tests (and CI) fail immediately. Downstream apps should follow the same pattern; see `docs/PUBLIC_API.md` and `docs/STREAMING_MARKDOWN_QUICKSTART.md` for extended examples.

---

## 6. Lists, callouts, and table parity

- **Callouts:** `@stream-mdx/plugins/callouts` exposes helpers to convert blockquotes with `> [!note]` syntax into semantic callout blocks. Pair with prose CSS for badge styling.
- **Footnotes:** `@stream-mdx/plugins/footnotes` manages definitions and backlinks; the default components render superscripts with accessible anchors.
- **Tables:** `@stream-mdx/plugins/tables` converts GitHub-flavored markdown tables into declarative block snapshots so incremental updates do not re-render the entire table.

Example (GFM callout + table):

```ts
import { createCalloutPlugin } from "@stream-mdx/plugins/callouts";
import { createTablePlugin } from "@stream-mdx/plugins/tables";

const registry = defaultPluginRegistry();
registry.use(createCalloutPlugin());
registry.use(createTablePlugin({ preferAppend: true }));
```

Run `npm run markdown-v2:test:tables` plus the streaming demo toggle to confirm bullets, numbering, and nested depths remain stable.

---

## 7. Tree-shake verification recipe

Use esbuild (already a project dependency) to bundle a single plugin sub-path:

```bash
npx esbuild packages/markdown-v2-plugins/src/plugins/math/index.ts \
  --bundle --format=esm --platform=browser --tree-shaking=true \
  --external:react --external:@stream-mdx/react > /tmp/math.js
wc -c /tmp/math.js  # expect < 25 KB
```

Repeat for other plugins as needed. The dedicated files under `dist/plugins/*` ensure that only the imported plugin code is included in downstream bundles.

---

## 8. Troubleshooting

- **TS5074 during build** – ensure you use `tsconfig.build.json` (incremental disabled) like the provided `packages/markdown-v2-plugins/tsconfig.build.json`.
- **Missing types** – add the relevant path to the `exports` map in `package.json`. The cookbook assumes every plugin has both `.js`/`.cjs` and `.d.ts` artifacts.
- **Bundlers pulling the whole suite** – confirm you import from sub-paths (`@stream-mdx/plugins/math`) instead of the root barrel export.
- **Worker/react registry mismatch** – always register the same plugin set on both sides. `<StreamingMarkdown plugins={[...]} />` handles this automatically; if you instantiate `MarkdownRenderer` manually, wire the same registry into the worker client.
- **CI analyzer noise** – if a snippet exercises a plugin that never emits coalescable patches (e.g., pure HTML sanitization), expect the analyzer to emit a warning (“No coalescable operations detected”) but not fail the run. Use the snippet filter env vars (`SNIPPET_FILTER`, `SNIPPET_SKIP`) to focus on plugin-relevant fixtures when debugging.
