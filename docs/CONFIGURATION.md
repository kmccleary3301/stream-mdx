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

To render MDX blocks:

- set `features={{ mdx: true }}`
- set `mdxCompileMode="worker"` (no server), or `"server"` (requires `/api/mdx-compile-v2`)
- provide `mdxComponents` if you use custom MDX components

## Rendering overrides

- `components`: override block renders (heading/code/table/etc).
- `inlineComponents`: override inline renders (strong/em/link/code/etc).
- `tableElements`: override table tags (Shadcn table wrappers).
- `htmlElements`: override HTML tag renders (when HTML is enabled).
- `codeRenderers`: map fenced code languages to custom renderers (e.g. `mermaid`, `artifact`, `diff`, custom languages) keyed by language; `{ component, aliases }` entries add alias languages, resolved case-insensitively.
- `allowedElements`: whitelist of permitted HTML tag names (mutually exclusive with `disallowedElements`).
- `disallowedElements`: blacklist of HTML tag names to drop (mutually exclusive with `allowedElements`).
- `unwrapDisallowed`: when `true`, render children of disallowed tags instead of dropping the subtree.
- `allowElement`: callback predicate `(element, context) => boolean` for dynamic tag filtering.
- `disableAutolinkProtocols`: protocols (e.g. `["mailto"]`) whose autolinks render as plain text while explicit markdown links remain active.
- `mathRenderer`: provide custom inline and display math renderers (KaTeX is built-in default; MathJax supported).
- `artifactHtml`: opt-in flag (`true` to render standard ````html ```` code fences via `ArtifactFrame`).

Mermaid is an **opt-in add-on** that renders fenced ` ```mermaid ` code blocks as diagrams (with a Diagram/Code toggle).

```bash
npm install @stream-mdx/mermaid
```

```tsx
import { MermaidBlock } from "@stream-mdx/mermaid";

<StreamingMarkdown
  text={text}
  codeRenderers={{ mermaid: MermaidBlock }}
/>;
```

## Scheduling and metrics

- `scheduling`: patch scheduler/backpressure knobs (frame budget, batch caps, history size).
- `onMetrics`: flush metrics callback (queue depth, timings, adaptive throttling state).

For exact types and defaults, see `docs/PUBLIC_API.md`.
