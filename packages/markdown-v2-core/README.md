# `@stream-mdx/core`

`@stream-mdx/core` is the React-free foundation of the StreamMDX stack. It provides the shared types, snapshot utilities, sanitization primitives, inline/mixed-content helpers, and performance/backpressure utilities used by the worker and renderer layers.

If you are building apps, start with [`stream-mdx`](../stream-mdx/README.md). Use `@stream-mdx/core` directly when you are building tooling, protocol consumers, performance instrumentation, or lower-level integrations.

## Install

```bash
npm install @stream-mdx/core
```

## Export Surface

| Export | Purpose |
| --- | --- |
| `@stream-mdx/core` | Main types/helpers surface |
| `@stream-mdx/core/types` | Shared types |
| `@stream-mdx/core/utils` | General utilities |
| `@stream-mdx/core/code-highlighting` | Code-highlighting helpers |
| `@stream-mdx/core/inline-parser` | Inline parsing helpers |
| `@stream-mdx/core/mixed-content` | Mixed-content parsing helpers |
| `@stream-mdx/core/worker-html-sanitizer` | Worker-side HTML sanitization helpers |
| `@stream-mdx/core/security` | Security-oriented helpers |
| `@stream-mdx/core/perf/backpressure` | Backpressure config and helpers |
| `@stream-mdx/core/perf/patch-batching` | Patch batching helpers |
| `@stream-mdx/core/perf/patch-coalescing` | Patch coalescing helpers |
| `@stream-mdx/core/streaming/custom-matcher` | Custom matcher hooks |
| `@stream-mdx/core/streaming/inline-streaming` | Inline streaming helpers |

## Typical Uses

### Backpressure tuning

```ts
import { DEFAULT_BACKPRESSURE_CONFIG } from "@stream-mdx/core/perf/backpressure";

export const rendererBackpressure = {
  ...DEFAULT_BACKPRESSURE_CONFIG,
  maxPendingBatches: 64,
};
```

### Patch batching/coalescing experiments

```ts
import { splitPatchBatch } from "@stream-mdx/core/perf/patch-batching";
```

### Lower-level typed integrations

Use `@stream-mdx/core` together with `@stream-mdx/protocol` when you want a typed transport or a non-React consumer of StreamMDX patch data.

### Settled inline preparation

`InlineParser.parseSettledPrefix(tail)` returns `{ settledTo, nodes, attemptedReferences }`. The boundary is a UTF-16 offset into the supplied tail. Retain the suffix for the next call; returned reference labels belong only to the settled prefix and remain dependencies for later definition changes.

Settlement follows the configured native tokenizer, including unresolved delimiters, opaque code and paired HTML. Undeclared custom parsers and whole-paragraph AST transforms retain the whole tail instead of claiming local reuse. Declarative rules use their existing anticipation declaration and exact compiled extension identity.

This prepares inline records only. It does not provide a paragraph owner, transport, renderer or constant-time guarantee for a large unfinished construct.

### Native block compatibility

`createBlockCompatibilityExtension()` keeps admitted GFM table body rows such as `--` and `===`, while a native thematic break still ends the table. Ordinary Setext headings, paragraph-to-table interruption, disabled tables and caller grammar overrides retain their respective behavior.

Core and Worker pin `@lezer/markdown` to 1.6.1 because native settlement and table compatibility inspect its private state. Re-establish the native grammar regressions before upgrading that dependency; this is not a replacement Markdown grammar.


## Related Packages

| Package | Role |
| --- | --- |
| [`@stream-mdx/worker`](../markdown-v2-worker/README.md) | Worker runtime and hosted worker helpers |
| [`@stream-mdx/react`](../markdown-v2-react/README.md) | React renderer and server helpers |
| [`@stream-mdx/protocol`](../markdown-v2-protocol/README.md) | Protocol envelope/types for transport |
| [`@stream-mdx/tui`](../markdown-v2-tui/README.md) | TUI utilities and snapshot store |

## Documentation

- [`../../docs/PUBLIC_API.md`](../../docs/PUBLIC_API.md)
- [`../../docs/SECURITY_MODEL.md`](../../docs/SECURITY_MODEL.md)
- [`../../docs/STREAMMDX_JSON_DIFF_SPEC.md`](../../docs/STREAMMDX_JSON_DIFF_SPEC.md)
- [`../../docs/DETERMINISM.md`](../../docs/DETERMINISM.md)
