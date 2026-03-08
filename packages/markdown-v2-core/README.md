# `@stream-mdx/core`

Core types + utilities shared across the StreamMDX stack.

This package is intentionally React-free. It contains structured-clone-safe types and helpers used by both the worker and the renderer.

Most consumers should install `stream-mdx` and follow the main docs. Use `@stream-mdx/core` directly if you’re building tooling or customizing lower-level behavior.

## Install

```bash
npm install @stream-mdx/core
```

## Entry points

- `@stream-mdx/core` (root)
- `@stream-mdx/core/types`
- `@stream-mdx/core/utils`
- `@stream-mdx/core/code-highlighting`
- `@stream-mdx/core/inline-parser`
- `@stream-mdx/core/mixed-content`
- `@stream-mdx/core/worker-html-sanitizer`
- `@stream-mdx/core/security`
- `@stream-mdx/core/perf/backpressure`
- `@stream-mdx/core/perf/patch-batching`
- `@stream-mdx/core/perf/patch-coalescing`
- `@stream-mdx/core/streaming/custom-matcher`

## Example

```ts
import { DEFAULT_BACKPRESSURE_CONFIG } from "@stream-mdx/core/perf/backpressure";

export function makeConfig(overrides?: Partial<typeof DEFAULT_BACKPRESSURE_CONFIG>) {
  return { ...DEFAULT_BACKPRESSURE_CONFIG, ...overrides };
}
```

## Docs

- API reference: https://github.com/kmccleary3301/stream-mdx/blob/main/docs/PUBLIC_API.md
- Security model: https://github.com/kmccleary3301/stream-mdx/blob/main/docs/SECURITY_MODEL.md
- Protocol spec (for typed stream events): https://github.com/kmccleary3301/stream-mdx/blob/main/docs/STREAMMDX_JSON_DIFF_SPEC.md

## Related packages

- `@stream-mdx/react` for the React renderer
- `@stream-mdx/worker` for hosted worker bundles
- `@stream-mdx/plugins` for worker-side plugin primitives (advanced)
- `@stream-mdx/protocol` for stable protocol/event types (e.g. TUIs)
- `@stream-mdx/tui` for NDJSON helpers + a snapshot store (terminal UIs)
- `@stream-mdx/mermaid` for Mermaid diagram rendering (optional)
- `@stream-mdx/theme-tailwind` for an optional Tailwind-friendly theme (optional)
