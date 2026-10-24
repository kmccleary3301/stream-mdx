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
- [Migrating from 0.5.0 to 1.0.0](#migrating-from-050-to-100)
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

## Native source and prepared content

List items keep primary text in a managed paragraph child. Task markers remain in authored source and render one checkbox, including empty tasks. Explicit cold `Block[]` exports retain the legacy item inline and mixed-content representation.

Late link definitions update existing nested paragraphs, tables and headings without widening authored ranges. Footnote publication updates affected paragraph and table occurrences in document reference order. Earlier cold snapshots remain historical; list looseness changes layout without rebuilding completed item content.

Generic nodes publish heading metadata and physical ranges with content updates. Metadata replacement and clearing reach both Core and React cold exports without changing earlier snapshots; managed source owners retain their existing guards.

CR is a Markdown line ending immediately; a following LF completes the same physical CRLF ending. Splitting that pair does not turn a valid table header back into prose. Canonical input retains both UTF-16 units. Root source-kind changes retire the old paragraph lease before publishing its replacement, including definition syntax that later becomes prose again.

Provisional HTML and allowlisted MDX lookahead changes only prepared content, not canonical input, physical UTF-16 ranges or cold raw exports. Repair stays within the owning paragraph. Rejected or over-budget markup, and openings left unclosed at `FINALIZE`, render literally. Speculative repair does not authorize MDX execution.

## Migrating from 0.5.0 to 1.0.0

Upgrade installed `stream-mdx` and `@stream-mdx/*` packages together to `1.0.0`, then recopy the matching hosted worker asset. Internal runtime dependencies are pinned to that version. The optional unified adapter requires core and React from the `^1.0.0` line.

This is a breaking release for custom integrations:

- The obsolete plugin `/registry`, `/base`, and `/math` exports, corresponding `stream-mdx/plugins/*` wrappers, and worker `/streaming/custom-matcher` export are removed. Replace global plugin registries and old math/match-handler factories with native Lezer extensions, serializable `SyntaxRuleSpec` rules, and instance document plugins. Native functions must be bundled into the worker, not sent through `INIT`. See the [plugin ABI](docs/PLUGIN_ABI.md).
- `MarkdownEngine` has instance-owned parser, queue, plugins, state, and caches. Its constructor accepts `{ post, extensions? }`; configuration and document resets use `handle({ type: "INIT", ... })`. `dispose()` is terminal. Use `serveMarkdownWorker` for a custom worker entry or `createInlineEngineWorker` for an in-process adapter. Worker URLs and actual Worker factories are renderer-owned and terminated on detach; existing Worker instances are borrowed. A caller-created inline adapter requires caller-owned termination. Follow the [public engine and ownership contracts](docs/PUBLIC_API.md#isolated-engine-and-native-extensions).
  `managedWorker={true}` requires a supplied Worker instance or a caller-accessible worker factory, with initialization and document commands owned by the caller. Worker URLs, omitted/default workers, and `engine="main"` are rejected in managed mode, even when a worker source is supplied. Use `engine="worker"` or `"auto"`; managed auto does not silently fall back to an inline engine. Supplied instances remain caller-owned; factory-created workers remain component-owned and terminate on detach.
- `ComponentRegistry` only marks components that differ from built-in defaults as custom. Paragraph and quote overrides must render their supplied `children` to retain engine-prepared inline, HTML, and nested-block content. Do not reparse raw prose to reconstruct those children. See the [rendering contract](docs/STREAMING_CORRECTNESS_CONTRACT.md).
- Custom code fence renderers must return `renderCode` directly. It is a React node, not a function. `language` and emitted language attributes preserve the authored info word, so a `js` fence reports `js`, not `javascript`. Canonical grammar fallback and renderer aliases still work. Unlabeled and indented code no longer emits language attributes. See the [code fence renderer contract](docs/PUBLIC_API.md#code-fence-renderer-contract).
- `restart()` cancels an async iterator; it does not replay it. Supply a fresh iterator for another stream. Replacing renderer-owned text resets its engine document; caller-initialized managed workers retain their document ownership.
- Provisional lookahead is bounded before completeness scanning. Every provisional input over 512 characters falls back to raw text, even when its delimiters are closed. Oversized finalized/nonprovisional complete content remains preserved; within-budget finalized projection retains its existing behavior. The declared caps are 512 scan characters, two newlines, six synthetic operations, nesting depth eight, one validation failure, and a cooperative five-millisecond provider guard. These are internal limits, not new React props or latency guarantees. See [configuration](docs/CONFIGURATION.md#formatanticipation).
- Core root exports no longer expose Lezer converter, math extension factory, link-label normalization, entity decoder, or default/regex plugin adapter internals. Use the retained `InlineParser`, streaming preparation APIs, `prepareNestedBlockSnapshot`, native extension configuration, and public worker/compiler entries. Owning parser settings remain authoritative, including disabled math in nested snapshot fallbacks. See [core parser and snapshot contracts](docs/PUBLIC_API.md#core-parser-and-snapshot-contracts).
- URL transforms and HTML/style sanitization apply in client, SSR, and unified rendering. Rejected URLs are omitted, and custom components must use the sanitized attributes and children they receive. `allowedElements` and `disallowedElements` cannot be supplied together. See the [security model](docs/SECURITY_MODEL.md).
- The old automatic MDX compile modes and `mdxComponents` prop are removed. Markdown remains native/restricted by default; full MDX requires a host-created `createTrustedMdxEngine` from `@stream-mdx/react/trusted-mdx`, an explicit import allowlist, `contentPolicy="trusted-mdx"`, and CSP permission for `unsafe-eval`. The trusted engine runs code in the host realm and is not a sandbox. See [MDX migration guidance](apps/docs/content/guides/mdx-and-html.md).

Controls, streaming animation, table virtualization, and custom renderer extensions remain opt-in. Read the generated package changelogs for the feature and correctness changes consumed into this release. For release operations, use the [Changesets/CI checklist](docs/STREAMING_MARKDOWN_RELEASE_CHECKLIST.md#6-packaging-and-publish-gates). The version-specific 0.5.0 release commands remain historical; they are not aliases for 1.0.

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
        footnotes: true,
        codeHighlighting: "incremental",
      }}
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

`engine` defaults to `"auto"`. It uses the existing inline engine to publish up to 4,096 accepted UTF-16 source units while worker setup and grammar prewarm are pending; further source is deferred beyond that bootstrap budget. Use `engine="worker"` to require a Worker or `engine="main"` to keep parsing on the browser thread. This does not change SSR behavior; use snapshot compilation for server markup. See [execution modes](docs/PUBLIC_API.md#execution-modes-and-ssr).

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

The host handle admits each imperative `append()` string atomically in JavaScript UTF-16 units. Offers over the 262,144-unit hard limit fail with non-retryable `SourceCapacityError` and accept no partial source. Keep offers at or below 65,536 units; when an offer returns `shouldPause`, wait for capacity before the next offer.

```tsx
"use client";

import { useEffect, useRef } from "react";
import { SourceCapacityError, StreamingMarkdown, type AppendResult, type StreamingMarkdownHandle } from "stream-mdx";

const MAX_OFFER_UNITS = 65_536;

export function LiveStream({ chunks }: { chunks: string[] }) {
  const ref = useRef<StreamingMarkdownHandle>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function run() {
      const handle = ref.current;
      if (!handle) return;

      const expectedSourceUnits = chunks.reduce((total, source) => total + source.length, 0);
      handle.restart();
      for (const source of chunks) {
        for (let offset = 0; offset < source.length;) {
          if (controller.signal.aborted) return;
          const chunk = source.slice(offset, offset + MAX_OFFER_UNITS);
          let admission: AppendResult;
          while (true) {
            try {
              admission = handle.append(chunk);
              break;
            } catch (error) {
              if (!(error instanceof SourceCapacityError) || !error.retryable) throw error;
              await handle.waitForCapacity({ units: chunk.length, signal: controller.signal });
            }
          }
          offset += chunk.length;
          if (admission.shouldPause && offset < source.length) {
            await handle.waitForCapacity({
              units: Math.min(MAX_OFFER_UNITS, source.length - offset),
              signal: controller.signal,
            });
          }
        }
        handle.flushPending();
        await handle.waitForIdle();
      }
      if (!controller.signal.aborted) {
        const result = await handle.finalize();
        if (
          !Number.isSafeInteger(result.generation) ||
          result.generation < 0 ||
          result.acceptedSourceUnits !== expectedSourceUnits ||
          result.committedSourceUnits !== expectedSourceUnits
        ) {
          throw new Error("Host finalization did not cover the complete source generation.");
        }
      }
    }

    void run().catch((error: unknown) => {
      if (!controller.signal.aborted) console.error("Streaming source failed", error);
    });
    return () => controller.abort(new Error("Stream generation cancelled"));
  }, [chunks]);

  return <StreamingMarkdown ref={ref} worker="/workers/markdown-worker.js" />;
}
```

`append()` returns `AppendResult` with cumulative admitted session units, current pending units, and `shouldPause`. Retry only a retryable `SourceCapacityError`, using `waitForCapacity` for the exact next offer; aborts and ended sessions remain visible failures. Automatic `stream` adapters preserve larger iterator chunks by losslessly slicing them into offers; they do not impose an arbitrary source-size cap. Session counters exclude `INIT.initialContent`. `finalize()` immediately seals host admission and resolves to `FinalizeResult` only after the native semantic-store barrier; it is not a DOM-commit or enrichment barrier.

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
  return <StreamingMarkdown text={text} worker="/workers/markdown-worker.js" codeRenderers={{ mermaid: MermaidBlock }} />;
}
```

### Plugin-oriented imports

```ts
import type { DocumentPlugin } from "@stream-mdx/plugins/document";
import { serveMarkdownWorker } from "@stream-mdx/worker/engine";

const headingMetadata: DocumentPlugin = {
  name: "heading-metadata",
  process(ctx) {
    for (const block of ctx.blocks) {
      if (block.type === "heading") {
        block.payload.meta = { ...block.payload.meta, documentPlugin: "heading-metadata" };
      }
    }
    return undefined;
  },
};

// Bundle this as a worker entry, not as application UI code.
serveMarkdownWorker({ extensions: { documentPlugins: [headingMetadata] } });
```

The [plugin ABI](docs/PLUGIN_ABI.md#3-custom-bundled-worker-entry) includes a complete bundled entry with native Lezer markdown and inline extensions. App-level regex rules use the serializable `syntax` prop and named `inlineComponents`.
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
| Build docs snapshots | `npm run docs:snapshots:build` | Builds packages and the hosted worker, then compiles doc snapshots. |
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

Managed seeded smoke writes static-server output to `tmp/seeded-smoke/docs-server.log`. The server logs directly to that file, so synchronous replay commands cannot stall HTTP responses by filling a log pipe.

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
