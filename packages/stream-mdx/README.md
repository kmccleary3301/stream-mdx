# `stream-mdx`

High-performance streaming Markdown/MDX renderer for React with a worker-first pipeline, incremental patching, and backpressure/guardrails.

This is the **convenience** package:

- `stream-mdx` (root) re-exports the main React API from `@stream-mdx/react`
- `stream-mdx/core`, `stream-mdx/plugins`, `stream-mdx/worker`, `stream-mdx/react` map to the scoped packages

If you want maximum modularity / tree-shaking control, install the scoped packages directly. Otherwise, start here.

## Full documentation

The npm README is intentionally a “front page”. The full manual lives in the repo:

- https://github.com/kmccleary3301/stream-mdx/blob/main/docs/COMPREHENSIVE_PROJECT_DOCUMENTATION.md

## Install

```bash
npm install stream-mdx
```

## Quickstart (Next.js / React)

`StreamingMarkdown` is a **client component**. Import it from a client file (or add `"use client"` at the top of your component file).

```tsx
"use client";

import { useMemo } from "react";
import { StreamingMarkdown } from "stream-mdx";
import { createDefaultWorker, releaseDefaultWorker } from "stream-mdx/worker";

export function Demo({ text }: { text: string }) {
  const worker = useMemo(() => createDefaultWorker(), []);

  return (
    <StreamingMarkdown
      worker={worker}
      value={text}
      onFinalize={() => releaseDefaultWorker(worker)}
    />
  );
}
```

If you’re in Next.js App Router and you accidentally import `StreamingMarkdown` from a **server component**, you’ll typically see `useRef is not a function` (React Server condition). Fix by moving the import into a `"use client"` boundary.

## What you can customize (high level)

`stream-mdx` is designed to be modular:

- Disable features: math, raw HTML, MDX compilation/hydration, etc (exact flags depend on your chosen plugin set + worker config).
- Swap rendering for tags: override `a`, `code`, `pre`, `table`, `thead`, `tr`, `td`, etc (e.g. Shadcn wrappers).
- Wrap expensive blocks (code blocks, math blocks) in your own containers (e.g. horizontal scroll) without touching the internal incremental rendering/backpressure logic.
- Change math delimiters: provide a different math tokenizer/config via plugins if you prefer `\\(...\\)` and `\\[...\\]` instead of `$...$` / `$$...$$`.

## Plugins

Plugins live in `stream-mdx/plugins` (or `@stream-mdx/plugins`). Common entrypoints:

- `@stream-mdx/plugins/document` – recommended default “doc plugins” bundle
- `@stream-mdx/plugins/tables` – table handling
- `@stream-mdx/plugins/html` – inline/raw HTML handling + sanitization hooks
- `@stream-mdx/plugins/math` – math tokenization + rendering
- `@stream-mdx/plugins/mdx` – MDX compilation/hydration helpers

For an end-to-end walkthrough (worker + renderer registration, CSP notes, math/MDX examples), see the repo docs:
- https://github.com/kmccleary3301/stream-mdx/tree/main/docs

## MDX compilation parity (server vs worker)

The project aims for **identical MDX compilation results** whether MDX is compiled:

- in the worker, or
- on the server (API endpoint) and hydrated on the client.

This avoids “it looks different depending on where it compiled” drift. Start from:
- `docs/REACT_INTEGRATION_GUIDE.md` (repo)
- `docs/PUBLIC_API.md` (repo)

## Security / HTML

If you enable raw HTML, treat it as an XSS surface:

- Use the worker to isolate parsing.
- Keep sanitization enabled (or provide your own schema).
- Set a CSP appropriate for your deployment (especially if you allow embeds).

Start from:
- `docs/STREAMING_MARKDOWN_V2_STATUS.md`
- `docs/STREAMING_MARKDOWN_RELEASE_CHECKLIST.md`

## Performance notes

The renderer is optimized for incremental updates (streaming text), coalesced patch application, and backpressure to prevent UI lockups on large documents.

If you’re benchmarking, start from:
- `docs/STREAMING_V2_BENCHMARKS.md`
- `docs/SNIPPET_ANALYSIS.md`

## Package map

If you need lower-level entrypoints, use:

- `stream-mdx/react` – React renderer + scheduler + types
- `stream-mdx/worker` – worker client + default worker helpers
- `stream-mdx/plugins` – plugin modules (math/MDX/tables/etc)
- `stream-mdx/core` – structured-clone-safe types + perf utilities
