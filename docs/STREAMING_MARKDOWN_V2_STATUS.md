# StreamMDX Handbook

_Last updated: 2025-12-17_

This handbook is the “current state” reference for StreamMDX: architecture, key decisions, and the workflows we expect contributors and maintainers to use.

If you’re looking for the consumer API first, start with:

- `docs/PUBLIC_API.md`
- `docs/REACT_INTEGRATION_GUIDE.md`

---

## 1) Project Summary

StreamMDX is a streaming-first Markdown/MDX renderer for React built around:

- **Worker-first parsing** (keeps heavy work off the main thread)
- **Incremental patching** (updates are applied to an existing render)
- **Backpressure guardrails** (prevents UI lockups on large documents/high update rates)
- **Modular feature flags** (tables/html/mdx/math/footnotes/callouts)

---

## 2) Packages

| Package | Notes |
| --- | --- |
| `stream-mdx` | Convenience wrapper; stable import paths for apps (recommended). |
| `@stream-mdx/react` | `<StreamingMarkdown />`, renderer store, patch scheduler, node views. |
| `@stream-mdx/worker` | Worker client utilities + hosted worker bundle (`dist/hosted/markdown-worker.js`). |
| `@stream-mdx/core` | Types, snapshot helpers, sanitization primitives, perf helpers. |
| `@stream-mdx/plugins/*` | Worker/plugin primitives and built-in domain helpers. |

---

## 3) Pipeline Overview

### 3.1 Worker

- Source: `packages/markdown-v2-worker/src/worker.ts`
- Output: `packages/markdown-v2-worker/dist/hosted/markdown-worker.js` (self-contained, browser-targeted)
- Responsibilities:
  - Parse Markdown incrementally.
  - Enrich blocks (e.g., syntax highlighting, MDX detection).
  - Emit patch batches + optional worker-side metrics.

### 3.2 React renderer

- Source: `packages/markdown-v2-react/src/streaming-markdown.tsx`
- Responsibilities:
  - Own the renderer store + patch scheduler.
  - Attach/detach the worker and forward text/stream updates.
  - Apply patches incrementally and render blocks with stable keys.
  - Emit flush metrics via `onMetrics`.

### 3.3 Backpressure and scheduling

- Credits/budgets live in `@stream-mdx/core/perf/backpressure`.
- Patch scheduling (frame budgets, batch caps, adaptive throttling) is implemented in `@stream-mdx/react`’s patch scheduler.

---

## 4) MDX

StreamMDX supports two MDX compilation modes:

- `mdxCompileMode="worker"`: compile in the worker.
- `mdxCompileMode="server"`: compile via an app-provided endpoint (default `/api/mdx-compile-v2`).

To keep parity between both strategies, use:

- `compileMdxContent` from `stream-mdx/worker/mdx-compile` (or `@stream-mdx/worker/mdx-compile`)

See `docs/REACT_INTEGRATION_GUIDE.md` for a working Next.js route example.

---

## 5) Security Model (HTML)

- Raw HTML is an XSS surface; StreamMDX sanitizes by default.
- Prefer hosted workers + strict CSP in production.
- If you extend HTML allowlists/schemas, do it only for trusted content.

---

## 6) Repo Workflows

### Build + test

- Install: `npm install`
- Build packages: `npm run build:packages`
- Run tests: `npm test`

### Build hosted worker for the example app

- `npm run worker:build`

This builds the hosted worker bundle and copies it into:

- `examples/streaming-markdown-starter/public/workers/markdown-worker.js`

### Example app

- `examples/streaming-markdown-starter` is the minimal Next.js sandbox used for manual QA.

---

## 7) Tabled / Future Work

The following are intentionally out-of-scope for the current “quality bridge” sprint:

- Deep benchmark harnesses and standardized perf reporting.
- Expanded plugin ecosystems (`presets`, `themes`, `highlighters`) beyond documentation and packaging boundaries.
- Marketing surfaces (domain/branding site) beyond a minimal docs portal.

