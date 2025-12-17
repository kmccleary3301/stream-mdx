# StreamMDX — Comprehensive Documentation

This is the “everything in one place” manual for the StreamMDX project.

- npm: `stream-mdx` (convenience wrapper)
- scoped packages: `@stream-mdx/{core,plugins,worker,react}`
- repo: https://github.com/kmccleary3301/stream-mdx

## Table of Contents

- [1. What StreamMDX Is](#1-what-streammdx-is)
- [2. Quickstart](#2-quickstart)
  - [2.1 Minimal Next.js usage](#21-minimal-nextjs-usage)
  - [2.2 Worker bundle placement](#22-worker-bundle-placement)
- [3. Conceptual Model](#3-conceptual-model)
  - [3.1 Worker-first parsing + patching](#31-worker-first-parsing--patching)
  - [3.2 Backpressure and responsiveness](#32-backpressure-and-responsiveness)
- [4. Public API (High Level)](#4-public-api-high-level)
- [5. Modularity & Feature Toggles](#5-modularity--feature-toggles)
  - [5.1 Can users drop math, HTML, MDX?](#51-can-users-drop-math-html-mdx)
  - [5.2 Math delimiters ( `$...$` vs `\\(...\\)` )](#52-math-delimiters--vs-)
- [6. Plugins](#6-plugins)
  - [6.1 Default “document” plugin set](#61-default-document-plugin-set)
  - [6.2 Tables (Shadcn variants)](#62-tables-shadcn-variants)
  - [6.3 HTML](#63-html)
  - [6.4 Math](#64-math)
  - [6.5 MDX](#65-mdx)
- [7. React Integration](#7-react-integration)
  - [7.1 Tag/component overrides](#71-tagcomponent-overrides)
  - [7.2 Wrapping code/math blocks (scroll containers, etc)](#72-wrapping-codemath-blocks-scroll-containers-etc)
- [8. MDX Hydration & Parity](#8-mdx-hydration--parity)
- [9. Security (CSP + Sanitization)](#9-security-csp--sanitization)
- [10. Performance & Tuning](#10-performance--tuning)
- [11. Troubleshooting](#11-troubleshooting)
- [12. Packages & Entry Points](#12-packages--entry-points)
- [13. Development, Testing, and Release](#13-development-testing-and-release)

---

## 1. What StreamMDX Is

StreamMDX is a streaming Markdown/MDX renderer designed for:

- **live streaming text** (token-by-token or chunk-by-chunk)
- **worker-first parsing/compilation** (keeps heavy work off the main thread)
- **incremental patching** (updates are applied to an existing render rather than re-rendering everything)
- **guardrails** (backpressure and coalescing to maintain UI responsiveness)

## 2. Quickstart

### 2.1 Minimal Next.js usage

`StreamingMarkdown` is a **client component**. Import it from a `"use client"` boundary.

```tsx
"use client";

import { StreamingMarkdown } from "stream-mdx";

export function StreamingArticle({ text }: { text: string }) {
  return (
    <StreamingMarkdown
      text={text}
      worker="/workers/markdown-worker.js"
      features={{ html: true, tables: true, math: true, mdx: true }}
      mdxCompileMode="worker"
    />
  );
}
```

If you import `StreamingMarkdown` from a Next.js server component, you’ll typically get `useRef is not a function`. Fix by moving the import behind a `"use client"` boundary.

### 2.2 Worker bundle placement

In production you generally want to serve the hosted worker bundle from your app’s `/public` (or equivalent static assets):

- copy the hosted worker from `node_modules` into your app:
  - `mkdir -p public/workers`
  - `cp node_modules/@stream-mdx/worker/dist/hosted/markdown-worker.js public/workers/markdown-worker.js`
- reference it by URL (recommended): `worker="/workers/markdown-worker.js"`

If you’re developing inside this repo, `npm run worker:build` builds the hosted worker and copies it into the example app for you.

If you’re using the included default worker helper (`createDefaultWorker`) it expects you to follow the project’s documented “hosted worker” pattern. Start from:

- `docs/REACT_INTEGRATION_GUIDE.md`
- `docs/PUBLIC_API.md`

## 3. Conceptual Model

### 3.1 Worker-first parsing + patching

At a high level:

1. Your app streams text in over time.
2. A worker receives text updates and parses/compiles into an internal block model.
3. The worker emits **patches** that describe how to update the current render.
4. The React renderer applies patches incrementally.

This design avoids “re-render the whole document on every chunk”.

### 3.2 Backpressure and responsiveness

The renderer uses backpressure to keep UI responsive on large documents or high update rates. When updates become too heavy, it will throttle/aggregate work so the main thread stays interactive.

See:
- `@stream-mdx/core/perf/backpressure`
- `docs/STREAMING_MARKDOWN_V2_STATUS.md`

## 4. Public API (High Level)

The full API reference lives in:
- `docs/PUBLIC_API.md`

The main things you’ll use:

- `StreamingMarkdown` (React component)
- a worker instance/client (usually via a hosted worker URL in production)
- optional plugin sets and render overrides (depending on your needs)

## 5. Modularity & Feature Toggles

### 5.1 Can users drop math, HTML, MDX?

Yes, by design the system is modular:

- **Math** can be disabled via `features={{ math: false }}`.
- **Raw HTML** can be disabled via `features={{ html: false }}` (recommended for untrusted inputs), or enabled with sanitization.
- **MDX** can be disabled via `features={{ mdx: false }}` (or left off entirely if you only want Markdown).

Where the toggles live depends on which layer you’re configuring:

- `features` (high-level app config; drives worker + renderer behavior)
- `docPlugins` (low-level worker init message; when you orchestrate the worker manually)
- renderer-side component mapping (how blocks/inline nodes render)

For the authoritative configuration surface and examples, see:
- `docs/REACT_INTEGRATION_GUIDE.md`
- `docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`

### 5.2 Math delimiters ( `$...$` vs `\\(...\\)` )

Default behavior typically targets the common Markdown math conventions:

- inline: `$...$`
- block: `$$...$$`

If you want ChatGPT-style delimiters:

- inline: `\\(...\\)`
- block: `\\[...\\]`

…you can do this by swapping the math tokenizer / configuration in the math plugin layer (the tokenizer is implemented as a plugin concern, not hard-coded into the renderer).

See the math plugin docs and tokenizer entrypoints:
- `@stream-mdx/plugins/math`
- `docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`

## 6. Plugins

### 6.1 Default “document” plugin set

StreamMDX organizes parsing/features by “document plugins”: a known set of remark/rehype capabilities and tokenizers that the worker uses.

Start from:
- `docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`

### 6.2 Tables (Shadcn variants)

Tables are intentionally customizable at the renderer layer. If you want Shadcn-like tables:

- register table handling in the worker (so tables are recognized)
- override the React render mapping for `table`, `thead`, `tr`, `th`, `td` to use your preferred component implementations/classes

See:
- `@stream-mdx/plugins/tables`
- `docs/REACT_INTEGRATION_GUIDE.md`

### 6.3 HTML

Raw/inline HTML support is optional. If enabled, you should treat it as a security boundary:

- sanitize
- isolate in a worker
- deploy with CSP

See:
- `@stream-mdx/plugins/html`
- `@stream-mdx/core/worker-html-sanitizer`
- `docs/STREAMING_MARKDOWN_V2_STATUS.md`

### 6.4 Math

Math support typically involves:

- parsing (tokenizer)
- rendering (KaTeX/renderer components)
- optional delayed rendering / stabilization during streaming

See:
- `@stream-mdx/plugins/math`
- `docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`

### 6.5 MDX

MDX adds a compilation/hydration pipeline and therefore additional deployment and security considerations. StreamMDX aims for **parity** between worker compilation and server compilation (see §8).

Start from:
- `@stream-mdx/plugins/mdx`
- `docs/REACT_INTEGRATION_GUIDE.md`

## 7. React Integration

### 7.1 Tag/component overrides

Users can customize rendering by providing tag overrides (e.g. links, code blocks, tables, headings) and/or higher-level component registries (depending on which API surface you use).

This is the core mechanism for:

- “change markdown tags and rendering styles”
- “wrap code blocks in scroll containers”
- “swap table components to Shadcn”

See:
- `docs/REACT_INTEGRATION_GUIDE.md`
- `docs/PUBLIC_API.md`

### 7.2 Wrapping code/math blocks (scroll containers, etc)

Wrapping expensive blocks is supported and should not meaningfully affect performance when done as a lightweight wrapper because:

- the inner renderer remains incremental and virtualized where applicable
- the wrapper does not force re-parsing or re-coalescing

Patterns:

- wrap `<pre>` / code blocks in a horizontal scroll container
- wrap block math in an overflow container

See:
- `docs/REACT_INTEGRATION_GUIDE.md`

## 8. MDX Hydration & Parity

StreamMDX aims to keep **client-side vs server-side** MDX compilation outputs aligned so:

- streaming mode and non-streaming mode match
- worker compilation and server compilation match

If you’re changing MDX behavior, treat parity as a regression surface. Start from:
- `docs/REACT_INTEGRATION_GUIDE.md`
- `docs/PUBLIC_API.md`

## 9. Security (CSP + Sanitization)

Key principles:

- prefer worker isolation for parsing/HTML
- sanitize HTML aggressively if enabled
- deploy with CSP suitable for your plugins/components (especially embeds)

References:

- `@stream-mdx/core/worker-html-sanitizer`
- `docs/STREAMING_MARKDOWN_V2_STATUS.md`

## 10. Performance & Tuning

The system’s key performance levers generally include:

- patch coalescing behavior (reduce update churn)
- backpressure configuration (keep UI interactive)
- streaming update rate (characters-per-second / chunk sizes)

References:
- `@stream-mdx/core/perf/patch-coalescing`
- `@stream-mdx/core/perf/backpressure`

## 11. Troubleshooting

- **`useRef is not a function` (Next.js App Router)**: importing a client component from a server boundary. Fix: move import behind `"use client"`.
- **Worker DOM globals (`DOMParser is not defined`)**: you’re running worker code that expects DOM APIs in a non-DOM worker context. Use the hosted worker bundle and avoid DOM-only code paths in the worker.
- **Registry verification weirdness**: `npm view` can show confusing auth-related messages if your local token is stale. Use `--userconfig=/dev/null` when verifying public package metadata.

## 12. Packages & Entry Points

- `stream-mdx` (convenience):
  - `stream-mdx` → `@stream-mdx/react` main surface
  - `stream-mdx/core` → `@stream-mdx/core`
  - `stream-mdx/plugins` → `@stream-mdx/plugins`
  - `stream-mdx/worker` → `@stream-mdx/worker`
  - `stream-mdx/react` → `@stream-mdx/react`

If you’re building a library on top of StreamMDX, prefer the scoped packages.

## 13. Development, Testing, and Release

- Install: `npm ci`
- Build: `npm run build`
- Test: `npm test`
- Hosted worker: `npm run worker:build`

Release checklist:
- `docs/STREAMING_MARKDOWN_RELEASE_CHECKLIST.md`
