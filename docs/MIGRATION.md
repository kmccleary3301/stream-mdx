# Migrating from 0.5.x

This major release changes the React presentation API and worker protocol. Upgrade StreamMDX packages together to the same release and rebuild or recopy the hosted worker with those packages. Do not pair this release's renderer with a 0.5.x worker or protocol consumer.

The snippets below use the current contracts in [Public API](./PUBLIC_API.md). They cover the breaking API changes recorded in this release's major changesets.

## React presentation API

`components` now accepts `NodePresentations`: semantic keys map to presentation entries with constrained `props` and either a `wrapper` or a headless `view`. A wrapper receives prepared `children`, bounded `metadata`, and source-bound `actions`; a headless view receives a node `handle`. Do not pass a full `Block` to a presentation.

### Replace BlockRenderer and legacy renderer props

`blockRenderer`, the `BlockComponents` registry, and the fragmented renderer override props have been removed. The old component-map values also need to become presentation entries.

Before:

```tsx
<StreamingMarkdown
  blockRenderer={blockComponents}
  components={{ table: TableView }}
  inlineComponents={inlineComponents}
  htmlElements={htmlElements}
  tableElements={tableElements}
  codeRenderers={codeRenderers}
  mathRenderer={mathRenderer}
  mdxComponents={mdxComponents}
/>
```

After:

```tsx
import type { InlineNodeViewProps, NodePresentations, NodeViewProps } from "@stream-mdx/react";

function CodeFrame({ children, metadata }: NodeViewProps) {
  return metadata.language?.toLowerCase() === "chart"
    ? <section>{children}</section>
    : children;
}

function TableFrame({ children }: NodeViewProps) {
  return <div className="table-frame">{children}</div>;
}

function MathView({ children }: InlineNodeViewProps) {
  return <span className="math-frame">{children}</span>;
}

function BadgeView({ children }: InlineNodeViewProps) {
  return <strong>{children}</strong>;
}

const components: NodePresentations = {
  code: { wrapper: CodeFrame, props: { "data-code-view": "custom" } },
  table: { wrapper: TableFrame },
  "inline:math": { view: MathView },
  "html:blockquote": { props: { className: "quote-frame" } },
  "extension:badge": { view: BadgeView },
};

<StreamingMarkdown text={markdown} components={components} />;
```

`wrapper` and `view` are mutually exclusive. `props` is limited to `className`, `style`, `title`, and `data-*` / `aria-*` attributes. Use `components["inline:<kind>"]` for inline nodes, `components["html:<tag>"]` for admitted and sanitized HTML, and `components["extension:<name>"]` for syntax-extension inline nodes. Table overrides use `components.table` and the `table-row` / `table-cell` keys. The two part keys accept only `wrapper` and `props`. For headless table rendering, give `components.table` a `view` and read rows with `useTableBlock` and `useTableRows`.

| Removed option | Replacement |
| --- | --- |
| `blockRenderer` / `BlockComponents` | `components: NodePresentations` with native block wrappers or views |
| `inlineComponents` | `components["inline:<kind>"]`, such as `inline:link` or `inline:strong` |
| `htmlElements` | `components["html:<tag>"]` after HTML admission and sanitization |
| `tableElements` | `components.table` and table-part presentation keys |
| `codeRenderers` | `components.code`; inspect `metadata.language` and return prepared `children` for languages you do not replace |
| `mathRenderer` as a presentation override | `components["inline:math"]` or `components.math`; custom TeX rendering belongs in `engines.math` |
| `mdxComponents` | `contentComponents` for registered restricted source components, or an explicit trusted MDX engine for full evaluation |

### Stop reading the full `Block` in wrappers

Before:

```tsx
function CodeWrapper({ block, children, metadata }: NodeViewProps) {
  const source = String(block.payload.raw ?? "");
  return metadata.language?.toLowerCase() === "chart"
    ? <pre>{source}</pre>
    : children;
}
```

After:

```tsx
function CodeWrapper({ children, metadata }: NodeViewProps) {
  return metadata.language?.toLowerCase() === "chart"
    ? <section>{children}</section>
    : children;
}
```

For source-dependent controls, use the source-bound `actions.readSource()` only when needed.

The `ComponentRegistry` constructor also takes one options object now.

Before:

```tsx
new ComponentRegistry(inlineComponents, codeRenderers, { mathRenderer });
```

After:

```tsx
new ComponentRegistry({ components });

```


Unified rendering uses the same `NodePresentations` object for StreamMDX nodes, and `MarkdownBlocksRenderer` uses that presentation contract for snapshots and server rendering. The HAST element map has a separate `hastComponents` option:

Before:

```tsx
const unified = createUnifiedRenderer({ components: { a: ExternalLink } });
```

After:

```tsx
const unified = createUnifiedRenderer({ hastComponents: { a: ExternalLink } });
<StreamingMarkdown components={unified} />;
```

### Remove `CodeNodeViewProps` and full-block access

`CodeNodeViewProps` is no longer exported. Use `HeadlessNodeViewProps<"code">` for a headless code view, registered under `components.code.view`:

Before:

```tsx
import type { CodeNodeViewProps } from "@stream-mdx/react";

function CodeView({ block }: CodeNodeViewProps) {
  return <pre>{String(block.payload.raw ?? "")}</pre>;
}
```

After:

```tsx
import { StreamingMarkdown, useCodeDiff } from "@stream-mdx/react";
import type { HeadlessNodeViewProps } from "@stream-mdx/react";

function CodeView({ handle }: HeadlessNodeViewProps<"code">) {
  const { lines } = useCodeDiff(handle, { from: 0, to: 100 });
  return <pre>{lines.map((line) => line.text).join("\n")}</pre>;
}

<StreamingMarkdown components={{ code: { view: CodeView } }} />;
```

A wrapper instead receives `NodeViewProps` (`children`, `metadata`, and `actions`). Use its prepared `children` when decorating native rendering; `actions.readSource()` is an explicit source read when a user action needs the full source.

### Move engine capabilities to `engines`

The presentation registry and the engines are separate. A code renderer that changes presentation belongs in `components.code`; a tokenizer belongs in `engines.code`. The current engine slots are `code`, `math`, `mermaid`, and `mdx`.

Before:

```tsx
<StreamingMarkdown
  codeRenderers={codeRenderers}
  mathRenderer={mathRenderer}
  mdxComponents={mdxComponents}
/>
```

After:

```tsx
import { createMermaidEngine } from "@stream-mdx/mermaid";

<StreamingMarkdown
  engine="main"
  engines={{
    code: codeEngine,
    math: mathEngine,
    mermaid: createMermaidEngine(),
  }}
/>
```

`engines.code` is a custom `CodeEngine` and is main-realm only, so pair it with `engine="main"`; worker tokenization must be registered in a custom worker. `engines.math` is a synchronous, server-render-safe `MathEngine`; KaTeX remains the default when omitted. `components["inline:math"]` decorates the selected engine's output and does not render TeX a second time. Mermaid fences can use `createMermaidEngine()` from `@stream-mdx/mermaid` through `engines.mermaid`; this replaces wrapper code that reached into `block.payload` to reconstruct the fence source.
Here `codeEngine` and `mathEngine` are application-defined implementations of those engine contracts.

### Rename the inline engine mode

`engine="main-thread"` is removed and throws an actionable migration error at runtime. Use `"main"`.

Before:

```tsx
<StreamingMarkdown engine="main-thread" text={markdown} />
```

After:

```tsx
<StreamingMarkdown engine="main" text={markdown} />
```

With `engine="auto"`, node IDs and source order stay the same when the inline bootstrap hands off to the worker, but node, code and table handles are issued again once. Views get the new handles automatically. If you keep a handle or a saved `actions.readSource` across that handoff, it rejects as stale, so read it again from the current view.

## MDX is an explicit trusted lane

The old per-block compile modes, hydration props, and default artifact execution are retired. Markdown remains native and the default restricted policy renders only registered source components. Use `defineContentComponent` with `contentComponents` for restricted source components. Full MDX requires a host-created `TrustedMdxEngine`, an explicit host import map, trusted content, `contentPolicy="trusted-mdx"`, and CSP permission for `unsafe-eval`.

Before:

```tsx
<StreamingMarkdown mdxComponents={widgets} />
```

After:

```tsx
import { createTrustedMdxEngine } from "@stream-mdx/react/trusted-mdx";
import { Callout } from "./Callout";

const hostWidgets = { Callout };
const mdxEngine = createTrustedMdxEngine({
  components: hostWidgets,
  imports: { "host:widgets": hostWidgets },
});

<StreamingMarkdown
  text={trustedMarkdown}
  features={{ mdx: true }}
  contentPolicy="trusted-mdx"
  engines={{ mdx: mdxEngine }}
/>;
```

Imports are explicit host bindings and are not fetched. Trusted evaluation runs in the host realm and is not a sandbox. Fences labeled `artifact` or `html-artifact` remain ordinary code unless the application supplies an explicit presentation. Worker `FINALIZED` reports native semantic completion, not trusted projection or React render readiness.

## Version the syntax descriptor

`syntax` is now a `SyntaxExtensionDescriptor`, not an unversioned array of inline rules. Containers share restricted-component admission, and each container names a `contentComponents` registration.
In 0.5.x, `syntax` accepted an unversioned `SyntaxRuleSpec[]`; wrap those rules in the descriptor's `inline` array and add `contractVersion: 1`.

Before:

```tsx
<StreamingMarkdown syntax={syntaxRules} />
```

After:

```tsx
import type { SyntaxExtensionDescriptor } from "@stream-mdx/core";

const syntax: SyntaxExtensionDescriptor = {
  contractVersion: 1,
  inline: syntaxRules,
  containers: [{ name: "notice", component: "Notice" }],
};

<StreamingMarkdown syntax={syntax} contentComponents={contentComponents} />;
```

Map each inline rule's name through `components["extension:<name>"]` when it needs a custom view.

## Update unified error handling

The unified adapter's error callback no longer receives a full `Block`. It receives an error and the compact `{ id, type, finalized }` context. This is the unified callback; `StreamingMarkdown`'s render-time `onError` remains a one-argument callback.

Before:

```tsx
createUnifiedRenderer({
  onError(error, block) {
    report(error, block.id, block.type);
  },
});
```

After:

```tsx
createUnifiedRenderer({
  onError(error, { id, type, finalized }) {
    report(error, { id, type, finalized });
  },
});
```

## Upgrade protocol and plugin consumers

The worker wire schema is `2.0`. Its envelope carries `schemaVersion`; update the renderer, worker, plugins, and protocol consumers together. The old `appendLines` operation has no compatibility alias. Code, paragraph, and table owners now publish typed operations.

Before:

```ts
import type { Patch } from "@stream-mdx/core";

type CodeAppend = Extract<Patch, { op: "appendLines" }>;
```

After:

```ts
import type { Patch } from "@stream-mdx/core";

type CodeAppend = Extract<Patch, { op: "appendCode" }>;
type ParagraphUpdate = Extract<Patch, { op: "appendParagraph" | "updateParagraphSpans" }>;
type TableUpdate = Extract<Patch, { op: "appendTableRows" | "updateTableRows" }>;
```

A document plugin should not retain a full `blocks` array between updates. Read the source snapshot from `ctx.source`; call `ctx.readBlocks()` only when a cold materialized block projection is needed.

Before:

```ts
const retainedBlocks = ctx.blocks;
```

After:

```ts
const source = ctx.source;
const blocks = ctx.readBlocks();
```

Code decoration results can now be `exactness: "unavailable"` with `tokens: null` (for example, when a diff hunk lacks the context needed to reconstruct tokenizer state). Narrow on `exactness` before consuming `tokens`.

Before:

```ts
const tokens = decoration.tokens;
```

After:

```ts
const tokens = decoration.exactness === "unavailable" ? null : decoration.tokens;
```

For diff code, `CodeBlockMetadata.diffStatus` is `"incomplete"`, `"malformed"`, or `"complete"`; it is separate from token exactness.

## Update Tailwind theme integration

The optional Tailwind theme now scopes native output styles and custom properties to the StreamMDX root. A standalone legacy `.markdown` wrapper outside that root no longer receives the theme's custom-property defaults. Set `colorScheme` on the native renderer when the host needs an explicit scheme.

Before:

```tsx
<div className="markdown dark">{renderedMarkdown}</div>
```

After:

```tsx
<StreamingMarkdown text={markdown} colorScheme="system" />
```

`colorScheme` accepts `"light"`, `"dark"`, or `"system"`. When omitted, an ancestor `.dark` class retains the existing class-based behavior; `"system"` follows `prefers-color-scheme` in CSS.

## New APIs

- `PreviewSlot`, `NativeNodeView`, and `PreviewRuntime` support explicit preview slots with an inert native fallback.
- `useNodeRevisionFeed` provides a revision feed and snapshot; `NodeRevisionFeed` and `NodeRevisionSnapshot` are the corresponding types.
- `CodeEngine` supports custom code tokenization on the main realm with `engine="main"`.
- Headless views can use `useNode` and `useNodeChildren` for node metadata and bounded child ranges, `useCodeBlock`, `useCodeLines`, and `useCodeDiff` for bounded code data, and `useTableBlock` and `useTableRows` for table metadata and row ranges.

See [Public API](./PUBLIC_API.md), the [React integration guide](./REACT_INTEGRATION_GUIDE.md), and the [security model](./SECURITY_MODEL.md) for the current contracts.
