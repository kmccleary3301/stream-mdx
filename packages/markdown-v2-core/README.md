# `@stream-mdx/core`

Pure TypeScript primitives shared across the streaming renderer stack. This package intentionally contains **no DOM/React code**; everything exported is structured-clone-safe so it can cross `postMessage` boundaries without serialization hacks.

## Install

```bash
npm install @stream-mdx/core
```

## Exports

| Module | Description |
| --- | --- |
| `types` | `Block`, `InlineNode`, `Patch`, `PatchBatch`, `RendererMetrics`, worker message unions. |
| `block-snapshot` | Helpers for cloning/mutating block trees in the worker. |
| `code-highlighting` | Shiki token utilities (`CodeLine`, `flattenHighlights`). |
| `mixed-content` | Inline HTML/Multi-block parsing helpers. |
| `inline-parser` | Incremental inline AST parser (Lezer wrappers). |
| `security` | Sanitization schema + trusted-types friendly helpers. |
| `utils` | Tree traversal, node ID generation, list depth normalization. |
| `perf/backpressure` | Back-pressure defaults + smoothing functions shared by worker/renderer. |
| `worker-html-sanitizer` | Preconfigured DOMPurify-like sanitization for worker context. |

See `packages/markdown-v2-core/src/index.ts` for the canonical export list.

## Usage

```ts
import type { Patch } from "@stream-mdx/core";
import { applyPatchBatch } from "@stream-mdx/core/block-snapshot";

export function replay(patches: Patch[]) {
  const snapshot = createInitialSnapshot();
  for (const patch of patches) {
    applyPatchBatch(snapshot, [patch]);
  }
  return snapshot;
}
```

The worker bundle (`@stream-mdx/worker`) consumes these helpers to build `Patch` batches, and the renderer uses the same types for its store/scheduler.

> For end-to-end math/MDX registration steps (worker + renderer), see [`docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md#5-math--mdx-workerrenderer-registration`](../../docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md#5-math--mdx-workerrenderer-registration).

## Security notes

- Sanitization helpers assume you pass trusted markdown inputs or run the worker in an isolated thread. If you enable raw HTML rendering, ensure you serve KaTeX/MDX assets from trusted origins and set CSP headers accordingly.
- `worker-html-sanitizer` exports a minimal schema. Override/augment it if you need to allow additional tags/attributes (e.g., custom `data-*` props).

## Roadmap

- Document semver guarantees once `1.0.0` ships.
- Publish detailed inline docs for every exported type (linkable from `docs/PUBLIC_API.md`).
