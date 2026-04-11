# StreamMDX

[![npm version](https://img.shields.io/npm/v/stream-mdx?logo=npm&color=CB3837)](https://www.npmjs.com/package/stream-mdx)
[![CI](https://img.shields.io/github/actions/workflow/status/kmccleary3301/stream-mdx/ci.yml?branch=main&label=CI&logo=github&color=2088FF)](https://github.com/kmccleary3301/stream-mdx/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/kmccleary3301/stream-mdx?color=2ea44f)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](./package.json)
[![React](https://img.shields.io/badge/react-%3E%3D18.2-61DAFB?logo=react&logoColor=black)](./packages/stream-mdx/package.json)
[![Docs Site](https://img.shields.io/badge/site-stream--mdx.vercel.app-000000?logo=vercel)](https://stream-mdx.vercel.app)
[![Demo](https://img.shields.io/badge/demo-live-FF6B35)](https://stream-mdx.vercel.app/demo)
[![Benchmarks](https://img.shields.io/badge/benchmarks-live-7C3AED)](https://stream-mdx.vercel.app/benchmarks)

StreamMDX is a streaming-first Markdown/MDX renderer for React with a worker-first pipeline, incremental patch application, deterministic snapshot compilation, and reliability tooling for people who care about correctness under load.

**Primary links**: [Website](https://stream-mdx.vercel.app) · [Docs](https://stream-mdx.vercel.app/docs) · [Demo](https://stream-mdx.vercel.app/demo) · [Showcase](https://stream-mdx.vercel.app/showcase) · [Benchmarks](https://stream-mdx.vercel.app/benchmarks) · [Perf Harness](https://stream-mdx.vercel.app/perf/harness) · [npm](https://www.npmjs.com/package/stream-mdx)

> [!TIP]
> If you want the default app integration, install `stream-mdx`, host the bundled worker as a static asset, and start with `<StreamingMarkdown />`.[^worker]

## Table of Contents

- [Why This Exists](#why-this-exists)
- [At a Glance](#at-a-glance)
- [Install Profiles](#install-profiles)
- [Quickstart](#quickstart)
- [Usage Patterns](#usage-patterns)
- [Package Matrix](#package-matrix)
- [Feature Surface](#feature-surface)
- [Repository Layout](#repository-layout)
- [Common Workflows](#common-workflows)
- [Architecture Summary](#architecture-summary)
- [Documentation Map](#documentation-map)
- [Reliability, Determinism, and Performance](#reliability-determinism-and-performance)
- [Security and Deployment Notes](#security-and-deployment-notes)
- [Contributing](#contributing)
- [License](#license)

## Why This Exists

Most Markdown renderers are optimized for static strings. StreamMDX is built for the harder case:

- append-only streams from LLMs, agents, logs, or structured event sources
- React applications that need to stay responsive while content is still arriving
- deployments that want worker isolation, hosted assets, and explicit CSP/security boundaries
- teams that want regression fixtures, seeded replay, snapshot parity, and measurable performance instead of hand-wavy claims

The repo is intentionally split so you can consume it at different levels:

- `stream-mdx` if you want the batteries-included app-facing dependency
- `@stream-mdx/react` if you want the renderer directly
- `@stream-mdx/worker` and `@stream-mdx/core` if you need the worker/runtime pieces separately
- `@stream-mdx/plugins/*`, `@stream-mdx/protocol`, and `@stream-mdx/tui` if you are extending the pipeline or consuming the patch stream outside React

## At a Glance

| Surface | What it is for | Where to start |
| --- | --- | --- |
| `stream-mdx` | Recommended install for React apps | [`packages/stream-mdx/README.md`](./packages/stream-mdx/README.md) |
| Docs site | Public docs, guides, showcase, benchmark pages | <https://stream-mdx.vercel.app/docs> |
| Live demo | Interactive streaming renderer sandbox | <https://stream-mdx.vercel.app/demo> |
| Benchmarks | In-browser comparison and timing views | <https://stream-mdx.vercel.app/benchmarks> |
| Perf harness | Focused perf surface and reproducible runs | <https://stream-mdx.vercel.app/perf/harness> |
| Example app | Minimal Next.js starter | [`examples/streaming-markdown-starter`](./examples/streaming-markdown-starter) |
| Docs source | Markdown docs consumed by the docs app | [`docs/`](./docs) |

## Install Profiles

| Profile | Install command | Use when |
| --- | --- | --- |
| Convenience | `npm install stream-mdx` | You want stable app-facing imports and the default React surface. |
| Modular | `npm install @stream-mdx/react @stream-mdx/worker @stream-mdx/core @stream-mdx/plugins` | You want to own the wiring explicitly or publish a library on top. |
| Mermaid addon | `npm install @stream-mdx/mermaid` | You want fenced `mermaid` blocks rendered as diagrams. |
| Tailwind theme | `npm install @stream-mdx/theme-tailwind` | You want an optional CSS baseline for streaming markdown output. |
| TUI / protocol | `npm install @stream-mdx/protocol @stream-mdx/tui` | You are consuming patch streams outside the browser. |

Recommended baseline:

```bash
npm install stream-mdx
```

Minimal modular baseline:

```bash
npm install @stream-mdx/react @stream-mdx/worker @stream-mdx/core @stream-mdx/plugins
```

## Quickstart

### 1. Host the worker bundle

```bash
mkdir -p public/workers
cp node_modules/@stream-mdx/worker/dist/hosted/markdown-worker.js public/workers/markdown-worker.js
```

### 2. Render streaming Markdown in React

```tsx
"use client";

import { StreamingMarkdown } from "stream-mdx";

export function Demo({ text }: { text: string }) {
  return (
    <StreamingMarkdown
      text={text}
      worker="/workers/markdown-worker.js"
      features={{
        tables: true,
        html: true,
        math: true,
        mdx: true,
        footnotes: true,
        codeHighlighting: "incremental",
      }}
      mdxCompileMode="worker"
      prewarmLangs={["tsx", "bash", "json"]}
    />
  );
}
```

### 3. Verify locally

```bash
npm install
npm run build:packages
npm run docs:worker:build:raw
npm run docs:snapshots:build:raw
npm -w stream-mdx-docs run dev
```

> [!NOTE]
> `StreamingMarkdown` is a client component. In Next.js App Router, import it behind a `"use client"` boundary.

## Usage Patterns

### Next.js App Router: minimal client boundary

```tsx
"use client";

import { StreamingMarkdown } from "stream-mdx";

export function Article({ markdown }: { markdown: string }) {
  return (
    <StreamingMarkdown
      text={markdown}
      worker="/workers/markdown-worker.js"
      features={{ tables: true, html: true, math: true, mdx: true }}
      caret="block"
    />
  );
}
```

### Append-only streaming with imperative control

```tsx
"use client";

import { useEffect, useRef } from "react";
import { StreamingMarkdown, type StreamingMarkdownHandle } from "stream-mdx";

export function LiveStream({ chunks }: { chunks: string[] }) {
  const ref = useRef<StreamingMarkdownHandle>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      ref.current?.restart();
      for (const chunk of chunks) {
        if (cancelled) break;
        ref.current?.append(chunk);
        ref.current?.flushPending();
        await ref.current?.waitForIdle();
      }
      ref.current?.finalize();
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [chunks]);

  return <StreamingMarkdown ref={ref} managedWorker worker="/workers/markdown-worker.js" />;
}
```

### Static / server compilation for SSR, SSG, and docs builds

```tsx
import { ComponentRegistry, MarkdownBlocksRenderer } from "@stream-mdx/react/server";
import { compileMarkdownSnapshot } from "stream-mdx/worker/node";

export default async function Page() {
  const { blocks } = await compileMarkdownSnapshot({
    text: "# Server render\n\nThis page was compiled ahead of time.",
    init: {
      docPlugins: {
        tables: true,
        html: true,
        mdx: true,
        math: true,
        footnotes: true,
      },
      mdx: { compileMode: "server" },
      prewarmLangs: ["typescript"],
    },
  });

  return <MarkdownBlocksRenderer blocks={blocks} componentRegistry={new ComponentRegistry()} />;
}
```

### Mermaid as an opt-in renderer

```tsx
import { MermaidBlock } from "@stream-mdx/mermaid";
import { StreamingMarkdown } from "stream-mdx";

export function DiagramDoc({ text }: { text: string }) {
  return <StreamingMarkdown text={text} worker="/workers/markdown-worker.js" components={{ mermaid: MermaidBlock }} />;
}
```

### Plugin-oriented imports

```ts
import { createDocumentPluginPreset } from "@stream-mdx/plugins/document";
import { createTablesPlugin } from "@stream-mdx/plugins/tables";
import { createMathPlugin } from "@stream-mdx/plugins/math";
```

If you are deciding between package layers:

1. Use `stream-mdx` unless you have a concrete reason not to.
2. Drop to `@stream-mdx/*` when you need tighter control over bundling, entry points, or internal wiring.
3. Reach for `@stream-mdx/protocol` or `@stream-mdx/tui` only when you are intentionally consuming the patch/event model outside React.

## Package Matrix

| Package | Role | Notes |
| --- | --- | --- |
| `stream-mdx` | Convenience wrapper | Re-exports the main React API and common subpaths. |
| `@stream-mdx/react` | React renderer | `<StreamingMarkdown />`, renderer store, scheduler, server render helpers, sticky-scroll components. |
| `@stream-mdx/worker` | Worker runtime | Worker client utilities, Node helpers, hosted worker bundle, direct compile helpers. |
| `@stream-mdx/core` | Core contracts | Types, snapshots, sanitization primitives, perf helpers, patch batching/coalescing helpers. |
| `@stream-mdx/plugins` | Built-in plugin suite | Tables, HTML, math, MDX, footnotes, callouts, registry helpers. |
| `@stream-mdx/mermaid` | Optional addon | Diagram rendering for fenced `mermaid` blocks. |
| `@stream-mdx/protocol` | External protocol surface | JSON/object protocol types for patch/event transport. |
| `@stream-mdx/tui` | Terminal helpers | NDJSON parsing and snapshot-store helpers for TUI consumers. |
| `@stream-mdx/theme-tailwind` | Optional theme CSS | Tailwind-friendly styling baseline for markdown output. |
| `apps/docs` | Product/docs site | The live docs, showcase, demo, and benchmark surfaces. |
| `examples/streaming-markdown-starter` | Minimal example app | Lightweight starter for local integration and manual QA. |

## Feature Surface

| Capability | Browser streaming | Node snapshot compile | Notes |
| --- | --- | --- | --- |
| Core Markdown + GFM blocks | 🟢 | 🟢 | Worker-first parsing and stable block snapshots. |
| Tables | 🟢 | 🟢 | Table-specific rendering hooks and tracked regressions. |
| Footnotes | 🟢 | 🟢 | Footnote aggregation with style regression coverage. |
| Sanitized HTML | 🟢 | 🟢 | Prefer trusted content and explicit allowlists. |
| Math | 🟢 | 🟢 | Inline + display math with KaTeX-compatible rendering paths. |
| MDX blocks | 🟢 | 🟢 | `worker` and `server` compile modes are both supported. |
| Incremental Shiki highlighting | 🟢 | n/a | `final`, `incremental`, and `live` code highlighting modes. |
| Mermaid addon | 🟢 | 🟢 | Provided via `@stream-mdx/mermaid`. |
| Custom plugins / regex extensions | 🟢 | 🟢 | Build on `@stream-mdx/plugins` and the worker pipeline. |
| TUI / NDJSON consumption | n/a | 🟢 | Use `@stream-mdx/protocol` and `@stream-mdx/tui`. |
| Seeded replay + snapshot regression harness | 🟢 | 🟢 | HTML/style snapshots, seeded smoke, determinism tooling. |

## Repository Layout

```text
stream-mdx/
├── apps/
│   └── docs/                         Next.js docs, demo, showcase, and benchmark site
├── docs/                             Deep reference docs, manuals, checklists, and plans
├── examples/
│   └── streaming-markdown-starter/   Minimal starter app
├── packages/
│   ├── markdown-v2-core/             Types, snapshots, sanitization, perf helpers
│   ├── markdown-v2-mermaid/          Mermaid addon
│   ├── markdown-v2-plugins/          Built-in plugin suite
│   ├── markdown-v2-protocol/         JSON/object protocol contracts
│   ├── markdown-v2-react/            React renderer, scheduler, server helpers
│   ├── markdown-v2-tui/              TUI and NDJSON helpers
│   ├── markdown-v2-worker/           Worker client, hosted worker, Node helpers
│   ├── stream-mdx/                   Convenience wrapper package
│   └── theme-tailwind/               Optional theme styles
├── scripts/
│   ├── determinism/                  Determinism and parity tooling
│   ├── perf/                         Perf harness, compare, and gate scripts
│   └── regression/                   HTML/style regression runners
├── tests/
│   ├── determinism/                  Determinism fixtures
│   └── regression/                   Regression fixtures and snapshots
├── CONTRIBUTING.md
├── DEPLOYMENT.md
├── SECURITY.md
└── package.json
```

## Common Workflows

| Goal | Command | Notes |
| --- | --- | --- |
| Install workspace deps | `npm install` | Requires Node `>=20`. |
| Build packages | `npm run build:packages` | Builds all publishable packages. |
| Build everything | `npm run build` | Includes the starter app build. |
| Run all workspace tests | `npm test` | Package-level tests across the monorepo. |
| Build hosted worker for docs/app surfaces | `npm run docs:worker:build` | Produces and copies `markdown-worker.js`. |
| Build docs snapshots | `npm run docs:snapshots:build` | Compiles markdown docs into snapshot artifacts. |
| Run docs locally | `npm run docs:dev` | Prepares packages, worker, docs snapshots, then starts Next dev. |
| Build docs for production | `npm run docs:build` | End-to-end docs build/export path. |
| Run regression suites | `npm run test:regression` | HTML + style snapshot suites. |
| Run seeded replay smoke | `npm run test:regression:seeded-smoke:server` | Managed-server seeded regression smoke. |
| Run reliability package checks | `npm run test:reliability:packages` | Focused package-level reliability checks. |
| Run docs reliability checks | `npm run test:reliability:docs` | Style snapshots + runtime race checks. |
| Run determinism matrix | `npm run determinism:matrix` | Worker determinism surface. |
| Run perf harness | `npm run perf:harness` | Baseline perf capture. |
| Compare perf runs | `npm run perf:compare` | Candidate vs base analysis. |
| Release gates | `npm run release:gates` | Current pre-release gate set. |

A useful local loop for maintainers is:

```bash
npm install
npm run build:packages
npm run test:regression:seeded-smoke:server
npm run docs:dev
```

## Architecture Summary

1. **Worker-first parsing**
   - Markdown/MDX parsing and heavy enrichment happen off the main thread.
   - The worker emits patch batches rather than a full-tree rerender on each update.
2. **Renderer store + patch scheduler**
   - The React layer owns a node/block store, applies patches incrementally, and schedules work under frame budgets.
   - Semantic vs enrichment work is tracked explicitly in the current reliability hardening path.
3. **Snapshot compilation path**
   - The same ecosystem can compile Markdown into block snapshots for SSR, SSG, and static export flows.
   - The docs site uses this model during build.
4. **Reliability and replay tooling**
   - Regression fixtures, seeded replay, style snapshots, runtime race tests, and release gates exist in-repo.
   - This is a library project with a testing surface, not just a render component.

## Documentation Map

### Start-here reading order

| If you are... | Read this first | Then |
| --- | --- | --- |
| Integrating into a React app | [`docs/GETTING_STARTED.md`](./docs/GETTING_STARTED.md) | [`docs/PUBLIC_API.md`](./docs/PUBLIC_API.md), [`docs/REACT_INTEGRATION_GUIDE.md`](./docs/REACT_INTEGRATION_GUIDE.md) |
| Extending the worker/plugin stack | [`docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`](./docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md) | [`docs/PLUGIN_ABI.md`](./docs/PLUGIN_ABI.md), [`docs/STREAMING_MARKDOWN_V2_STATUS.md`](./docs/STREAMING_MARKDOWN_V2_STATUS.md) |
| Evaluating correctness/reliability | [`docs/REGRESSION_TESTING.md`](./docs/REGRESSION_TESTING.md) | [`docs/STREAMING_CORRECTNESS_CONTRACT.md`](./docs/STREAMING_CORRECTNESS_CONTRACT.md), [`docs/STREAMING_CORRECTNESS_EXECUTION_PLAN.md`](./docs/STREAMING_CORRECTNESS_EXECUTION_PLAN.md) |
| Evaluating performance | [`docs/PERF_HARNESS.md`](./docs/PERF_HARNESS.md) | [`docs/PERFORMANCE_GUIDE.md`](./docs/PERFORMANCE_GUIDE.md), [`docs/PERF_QUALITY_CHANGELOG.md`](./docs/PERF_QUALITY_CHANGELOG.md) |
| Using non-browser / TUI surfaces | [`docs/TUI_GUIDE.md`](./docs/TUI_GUIDE.md) | [`docs/TUI_MINIMAL_EXAMPLE.md`](./docs/TUI_MINIMAL_EXAMPLE.md), [`examples/tui-minimal/README.md`](./examples/tui-minimal/README.md), [`docs/CLI_USAGE.md`](./docs/CLI_USAGE.md), [`docs/STREAMMDX_JSON_DIFF_SPEC.md`](./docs/STREAMMDX_JSON_DIFF_SPEC.md) |

### Docs and site links

| Topic | Repo doc | Site route |
| --- | --- | --- |
| Docs overview | [`docs/README.md`](./docs/README.md) | <https://stream-mdx.vercel.app/docs> |
| Getting started | [`docs/GETTING_STARTED.md`](./docs/GETTING_STARTED.md) | <https://stream-mdx.vercel.app/docs/getting-started> |
| Public API | [`docs/PUBLIC_API.md`](./docs/PUBLIC_API.md) | <https://stream-mdx.vercel.app/docs/public-api> |
| React integration | [`docs/REACT_INTEGRATION_GUIDE.md`](./docs/REACT_INTEGRATION_GUIDE.md) | <https://stream-mdx.vercel.app/docs/react-integration> |
| Plugin cookbook | [`docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`](./docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md) | <https://stream-mdx.vercel.app/docs/plugins-cookbook> |
| Status / architecture | [`docs/STREAMING_MARKDOWN_V2_STATUS.md`](./docs/STREAMING_MARKDOWN_V2_STATUS.md) | <https://stream-mdx.vercel.app/docs/status> |
| Streamdown comparison | [`docs/STREAMDOWN_COMPARISON.md`](./docs/STREAMDOWN_COMPARISON.md) | <https://stream-mdx.vercel.app/docs/streamdown-comparison> |
| Minimal TUI example | [`docs/TUI_MINIMAL_EXAMPLE.md`](./docs/TUI_MINIMAL_EXAMPLE.md) | [`examples/tui-minimal/README.md`](./examples/tui-minimal/README.md) |
| Showcase index | [`apps/docs/content/showcase/index.ts`](./apps/docs/content/showcase/index.ts) | <https://stream-mdx.vercel.app/showcase> |
| Guides index | [`apps/docs/content/guides/index.ts`](./apps/docs/content/guides/index.ts) | <https://stream-mdx.vercel.app/guides> |

## Reliability, Determinism, and Performance

This repo is unusually heavy on verification because streaming renderers fail in ways that are easy to miss if you only test final static output.

| Concern | Current mechanism | Entry point |
| --- | --- | --- |
| HTML regression parity | Seeded browser snapshot runner | `npm run test:regression:html` |
| CSS/style parity | Computed-style snapshots | `npm run test:regression:styles` |
| Seeded smoke | Managed-server replay on selected fixtures | `npm run test:regression:seeded-smoke:server` |
| Runtime races | Worker/runtime race checks | `npm run test:runtime:worker-races` |
| Determinism | Worker matrix + HTML parity tools | `npm run determinism:matrix`, `npm run determinism:html-parity` |
| Perf baselines | Harness capture and comparisons | `npm run perf:harness`, `npm run perf:compare`, `npm run perf:gate` |
| Release gating | Aggregated release checks | `npm run release:gates` |

Useful references:

- [`docs/REGRESSION_TESTING.md`](./docs/REGRESSION_TESTING.md)
- [`docs/BASELINE_UPDATE_POLICY.md`](./docs/BASELINE_UPDATE_POLICY.md)
- [`docs/DETERMINISM.md`](./docs/DETERMINISM.md)
- [`docs/PERF_HARNESS.md`](./docs/PERF_HARNESS.md)
- [`docs/PERF_QUALITY_CHANGELOG.md`](./docs/PERF_QUALITY_CHANGELOG.md)
- [`docs/STREAMING_CORRECTNESS_CONTRACT.md`](./docs/STREAMING_CORRECTNESS_CONTRACT.md)
- [`docs/STREAMING_MARKDOWN_RELEASE_CHECKLIST.md`](./docs/STREAMING_MARKDOWN_RELEASE_CHECKLIST.md)

## Security and Deployment Notes

- Hosted workers are the recommended production path; they keep the worker URL explicit and fit stricter CSPs better than `blob:` fallbacks.[^worker]
- HTML rendering is a security boundary. Treat custom allowlists and overrides as security-sensitive configuration, not as mere presentation choices.
- MDX has two compile modes:
  - `worker` for self-contained browser compilation
  - `server` when you want an explicit app-owned compile endpoint and tighter control over the compile boundary
- The repo includes both a Vercel-hosted site and a GitHub Pages mirror.[^mirror]

## Contributing

| Resource | Link |
| --- | --- |
| Contributing guide | [`CONTRIBUTING.md`](./CONTRIBUTING.md) |
| Security policy | [`SECURITY.md`](./SECURITY.md) |
| Deployment notes | [`DEPLOYMENT.md`](./DEPLOYMENT.md) |
| Code of conduct | [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) |
| Docs navigator | [`docs/README.md`](./docs/README.md) |

If you are contributing in the renderer/worker core, the minimum useful context is usually:

- [`docs/PUBLIC_API.md`](./docs/PUBLIC_API.md)
- [`docs/STREAMING_MARKDOWN_V2_STATUS.md`](./docs/STREAMING_MARKDOWN_V2_STATUS.md)
- [`docs/STREAMING_CORRECTNESS_CONTRACT.md`](./docs/STREAMING_CORRECTNESS_CONTRACT.md)
- [`docs/STREAMING_CORRECTNESS_EXECUTION_PLAN.md`](./docs/STREAMING_CORRECTNESS_EXECUTION_PLAN.md)

## License

StreamMDX is released under the [MIT License](./LICENSE).

[^worker]: Hosting `markdown-worker.js` from your own static assets avoids the need for a `blob:` worker policy in stricter CSP setups.
[^mirror]: The Vercel deployment is the current primary site. GitHub Pages remains available as a mirror at <https://kmccleary3301.github.io/stream-mdx/>.
