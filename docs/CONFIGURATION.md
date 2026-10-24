# Configuration

This page summarizes the configuration surface exposed by `<StreamingMarkdown />`.

## Feature flags

`features` toggles built-in domains in the worker + renderer:

```tsx
<StreamingMarkdown
  text={text}
  features={{ tables: true, html: true, mdx: true, math: true, footnotes: true, callouts: false, formatAnticipation: false }}
/>;
```

### `formatAnticipation`

When `features.formatAnticipation` is enabled, StreamMDX will attempt to **withhold formatting markers while streaming** (initial support: `*`, `**`, `` ` ``, `~~`). This is strictly a *streaming UX* improvement; finalized output remains unchanged.

Provisional lookahead has fixed internal budgets, not additional React configuration props. The declared defaults are `maxScanChars: 512`, `maxNewlines: 2`, `maxSyntheticOps: 6`, `maxNestingDepth: 8`, `maxValidationFailures: 1`, and `maxProviderMs: 5`. Provider timers start before scanning; the time limit is a cooperative guard, not a latency guarantee.

Every provisional input longer than 512 characters falls back to raw text before a completeness scan, including a string whose delimiters are already closed. Scanning an unbounded string to decide whether it is complete would defeat the guard. Oversized finalized or otherwise nonprovisional complete content is preserved. Within the budgets, the existing finalized projection remains available; finalization does not categorically disable every repair or projection path. Math-disabled owning parser contexts keep dollar text literal, including nested snapshot fallbacks.

## Worker

Recommended: host the worker and pass a URL string:

```tsx
<StreamingMarkdown worker="/workers/markdown-worker.js" />
```

If you omit `worker`, StreamMDX uses the default worker strategy and falls back to `/workers/markdown-worker.js`.

## MDX

Set `features={{ mdx: true }}` to recognize component syntax. `contentPolicy` defaults to `"restricted"`; source is not automatically evaluated. Under that policy, `contentComponents` is a map of `defineContentComponent` adapters, not raw constructors. Narrow source JSON props require a type-predicate validator, while native projected children stay separate as host React nodes. This registry is not active under `"markdown"` or `"trusted-mdx"` and is separate from `components`, which overrides native Markdown presentation.

Full MDX evaluation requires `contentPolicy="trusted-mdx"` and an explicit `engines.mdx` created with `createTrustedMdxEngine` from `@stream-mdx/react/trusted-mdx`. Its import map accepts only explicit host bindings; it does not fetch modules, is not a sandbox, and requires `unsafe-eval` in the host `script-src`. Use it only for trusted, reviewed content. See the [React Integration Guide](./REACT_INTEGRATION_GUIDE.md) and [Security Model](./SECURITY_MODEL.md).

## Rendering overrides

- `components`: override native block, inline, and HTML presentation nodes. Use `code` and `table` wrappers, `inline:<kind>` or `extension:<name>` views, and `html:<tag>` presentations.
- `contentComponents`: register fixed host components for restricted MDX source.
- `allowedElements`: whitelist permitted HTML tag names (mutually exclusive with `disallowedElements`).
- `disallowedElements`: blacklist HTML tag names (mutually exclusive with `allowedElements`).
- `unwrapDisallowed`: when `true`, render children of disallowed tags instead of dropping the subtree.
- `allowElement`: callback predicate `(element, context) => boolean` for dynamic tag filtering.
- `allowedElements`: whitelist of permitted HTML tag names (mutually exclusive with `disallowedElements`).
- `disallowedElements`: blacklist of HTML tag names to drop (mutually exclusive with `allowedElements`).
- `unwrapDisallowed`: when `true`, render children of disallowed tags instead of dropping the subtree.
- `allowElement`: callback predicate `(element, context) => boolean` for dynamic tag filtering.
- `disableAutolinkProtocols`: protocols (e.g. `["mailto"]`) whose autolinks render as plain text while explicit markdown links remain active.
- `mathRenderer`: provide custom inline and display math renderers (KaTeX is built-in default; MathJax supported).

Mermaid is an **opt-in add-on** that renders fenced ` ```mermaid ` code blocks as diagrams (with a Diagram/Code toggle).

```bash
npm install @stream-mdx/mermaid
```

```tsx
import { StreamingMarkdown, type NodeViewProps } from "stream-mdx";
import { MermaidBlock } from "@stream-mdx/mermaid";

function MermaidPresentation({ block, children, metadata, actions }: NodeViewProps) {
  if (metadata.language?.toLowerCase() !== "mermaid") return children;
  const code = block?.payload.meta?.code;
  return (
    <MermaidBlock
      code={typeof code === "string" ? code : ""}
      renderCode={children}
      language={metadata.language ?? "mermaid"}
      blockId={metadata.id}
      controls={{ copy: true }}
      copy={actions.copy}
    />
  );
}

<StreamingMarkdown text={text} components={{ code: { wrapper: MermaidPresentation } }} />;
```

## Scheduling and metrics

- `scheduling`: patch scheduler/backpressure knobs (frame budget, batch caps, history size).
- `onMetrics`: flush metrics callback (queue depth, timings, adaptive throttling state).

For exact types and defaults, see `docs/PUBLIC_API.md`.
