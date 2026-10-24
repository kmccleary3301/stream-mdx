# StreamMDX Handbook

_Last updated: 2026-10-08_

This handbook is the “current state” reference for StreamMDX: architecture, key decisions, and the workflows we expect contributors and maintainers to use.

If you’re looking for the consumer API first, start with:

- `docs/PUBLIC_API.md`
- `docs/REACT_INTEGRATION_GUIDE.md`

---

## 1) Project Summary

StreamMDX is a streaming-first Markdown/MDX renderer for React built around:

- **Instance-scoped parsing** with worker, main-thread, and automatic execution modes
- **Incremental patching** (updates are applied to an existing render)
- **Backpressure guardrails** (prevents UI lockups on large documents/high update rates)
- **Modular feature flags** (tables/html/mdx/math/footnotes/callouts)

---

## 2) Packages

| Package | Notes |
| --- | --- |
| `stream-mdx` | Convenience wrapper; stable import paths for apps (recommended). |
| `@stream-mdx/react` | `<StreamingMarkdown />`, renderer store, patch scheduler, node views. |
| `@stream-mdx/react/trusted-mdx` | Explicit full-MDX engine for trusted, reviewed source; not re-exported from the React root. |
| `@stream-mdx/worker` | Worker client utilities + hosted worker bundle (`dist/hosted/markdown-worker.js`). |
| `@stream-mdx/core` | Types, snapshot helpers, sanitization primitives, perf helpers. |
| `@stream-mdx/plugins/*` | Worker/plugin primitives and built-in domain helpers. |
| `@stream-mdx/unified` | Optional remark/rehype adapter for finalized blocks. |
| `@stream-mdx/mermaid` | Optional Mermaid fence renderer. |

---

## 3) Pipeline Overview

### 3.1 Worker

- Source: `packages/markdown-v2-worker/src/worker.ts`
- Output: `packages/markdown-v2-worker/dist/hosted/markdown-worker.js` (self-contained, browser-targeted)
- Responsibilities:
  - Parse Markdown incrementally.
  - Enrich blocks (e.g., syntax highlighting, MDX detection).
  - Emit patch batches + optional worker-side metrics.
  - Own an isolated `MarkdownEngine`; custom worker entries configure native Lezer extensions and document plugins through `@stream-mdx/worker/engine`.

### 3.2 React renderer

- Source: `packages/markdown-v2-react/src/streaming-markdown.tsx`
- Responsibilities:
  - Own the renderer store + patch scheduler.
  - Attach/detach the selected transport and forward text/stream updates.
  - Apply patches incrementally and render blocks with stable keys.
  - Emit flush metrics via `onMetrics`.

### 3.3 Backpressure and scheduling

- Credits/budgets live in `@stream-mdx/core/perf/backpressure`.
- Patch scheduling (frame budgets, batch caps, adaptive throttling) is implemented in `@stream-mdx/react`’s patch scheduler.
- Default scheduling uses a microtask batch with a 10ms frame budget (`DEFAULT_SCHEDULING` in `packages/markdown-v2-react/src/streaming-markdown.tsx`).
- For smoother UI at the cost of latency, use the rAF-based preset (`DEFAULT_SCHEDULING_SMOOTH`) or pass `scheduling` explicitly.

---

## 4) MDX

`contentPolicy` defaults to `"restricted"` and does not evaluate authored expressions. Use `defineContentComponent`-backed `contentComponents` for fixed host components under that policy; validators and component callbacks stay on the host, with native children passed separately. The registry is not activated by `"markdown"` or `"trusted-mdx"`.

Full MDX requires an explicit `createTrustedMdxEngine` from `@stream-mdx/react/trusted-mdx`, passed through `engines.mdx` with `contentPolicy="trusted-mdx"`. The host import map resolves explicit bindings only and never fetches modules. Evaluation requires `unsafe-eval`, executes authored code in the host realm, and is not a sandbox. `FINALIZED` is native semantic completion, not trusted preparation or render readiness. See `docs/REACT_INTEGRATION_GUIDE.md` and `docs/SECURITY_MODEL.md`.

---

## 5) Security Model (HTML and MDX)

- Raw HTML is an XSS surface; StreamMDX sanitizes by default.
- Prefer hosted workers + strict CSP in production.
- If you extend HTML allowlists/schemas, do it only for trusted content.
- Keep untrusted MDX under the default restricted policy. Full MDX requires an explicit trusted engine, runs in the host realm, and is not sandboxed.
- `artifact` and `html-artifact` fences render as code unless the host supplies a custom renderer. StreamMDX has no built-in artifact sandbox.

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

### Perf baselines (local)

- Latest baselines live in `docs/perf/LOCAL_BENCHMARKS.md` (naive-bayes + table-large scenarios).
- Comparisons and guardrail notes are recorded in `docs/PERF_QUALITY_CHANGELOG.md`.
- Re-run comparisons with:
  - `npm run perf:compare -- --base <base> --candidate <candidate>`

---

## 7) Engine-v2 delivery evidence

- Node 20 integrated suites: 21 core, 52 worker, 48 React, one unified, and one Mermaid test file passed.
- Review-phase additions preserve default output unless enabled: opt-in code/table/Mermaid `controls` (rendered beside `<pre>`, never inside it), `animated` streaming text, render-time element filters (`allowedElements`/`disallowedElements`/`allowElement`/`unwrapDisallowed`/`disableAutolinkProtocols`), configurable Shiki themes, and a render-time `urlTransform`. Shiki's built-in language aliases map short labels such as `js` to grammar names. Render-time props re-render mounted blocks without restarting the stream.
- CommonMark/GFM corpus (675 cases): 675/675 static, streaming, and SSR cases under normalized semantics with zero streaming divergences (retaining the 675 ratchet baseline). Under strict semantics preserving link/image titles and code language-* info strings, StreamMDX scores 675/675 across all three paths with zero streaming divergences (unlabeled and indented code blocks emit bare `<pre><code>` with no class). For comparison, micromark scores 669/675 (5 GFM tagfilter differences + 1 dropped FTP autolink), Streamdown default chat mode scores 540/675, and Streamdown raw HTML mode scores 586/675. This is the configured corpus, not universal conformance.
- Final production HTML regressions: 109/109 scenarios passed in a non-update run against the production docs build.
- Fresh packed ESM/CJS consumers and production Next/Vite builds passed on Node 20. Real main-thread browser consumers rendered remark/rehype output and Mermaid SVGs.
- Physical browser workers exercised native Lezer grammar/inline extensions, document plugins, and serialized syntax rules. Finalized table virtualization retained the last row through streaming replacement and rendered every row when disabled.
- Consumer API, renderer replacements, custom code renderers, chat example, and optional unified integration are documented in `docs/PUBLIC_API.md` and `docs/REACT_INTEGRATION_GUIDE.md`.

Performance results require completed measurements and equivalent rendered semantics. Do not infer a speed claim from correctness scores or invalid comparisons; see `docs/STREAMDOWN_COMPARISON.md`.
