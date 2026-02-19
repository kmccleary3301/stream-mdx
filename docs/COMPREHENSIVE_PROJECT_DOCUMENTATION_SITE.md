# StreamMDX Comprehensive Manual

This is the site-oriented manual for StreamMDX. It is intentionally structured for practical implementation flow and deployment readiness.

- npm package: `stream-mdx` (convenience wrapper)
- scoped packages: `@stream-mdx/{core,plugins,worker,react,mermaid,protocol,tui}`
- repository: <https://github.com/kmccleary3301/stream-mdx>

## 1) What StreamMDX is

StreamMDX is a deterministic, worker-first Markdown/MDX renderer optimized for progressive updates.

- Incremental patching, not full document re-render
- Stable block snapshots for replay and testing
- Optional feature layers (MDX, math, HTML, Mermaid) without forcing all cost up front

## 2) Quickstart

Install:

```bash
npm install stream-mdx
```

Minimal React usage:

```tsx
"use client";

import { StreamingMarkdown } from "stream-mdx";

export function Demo({ text }: { text: string }) {
  return <StreamingMarkdown text={text} worker="/workers/markdown-worker.js" />;
}
```

## 3) Worker model and hosting

The worker handles parse + patch generation; React applies patches and renders blocks.

- Prefer static worker hosting from `/public/workers/markdown-worker.js`
- Keep CSP strict by avoiding `blob:` mode in production
- Use node worker helpers for CLI/TUI or server-side snapshot workflows

## 4) Public API (high level)

Primary surfaces:

- `StreamingMarkdown` (React renderer)
- `stream-mdx/worker` and `stream-mdx/worker/node` (worker helpers)
- `stream-mdx/plugins/*` (plugin primitives)

See full API details: [`/docs/public-api`](/docs/public-api)

## 5) Feature toggles and modularity

Enable only what your route needs:

- `html`, `tables`, `math`, `mdx`, `formatAnticipation`
- `@stream-mdx/mermaid` for Mermaid blocks
- Design-system overrides via `htmlElements` and `tableElements`

## 6) Plugins

Default and custom plugins run worker-side.

- Keep plugins deterministic (no async/random side effects)
- Validate parser boundaries with regression fixtures
- Keep plugin contracts versioned

See cookbook: [`/docs/plugins-cookbook`](/docs/plugins-cookbook)

## 7) React integration patterns

Recommended usage:

- Render `StreamingMarkdown` from client components
- Keep worker URL stable and cacheable
- Handle runtime errors with explicit fallback UI

See integration guide: [`/docs/react-integration`](/docs/react-integration)

## 8) MDX hydration and parity

For MDX-heavy docs:

- Choose compile mode intentionally (server API vs worker)
- Keep component registries explicit and versioned
- Track hydration latency and error rates in perf harness

## 9) Security model (CSP + sanitization)

Production baseline:

- Sanitize untrusted HTML
- Restrict script sources and worker origins
- Keep link handling and target behavior safe by default

See security guide: [`/docs/security-model`](/docs/security-model)

## 10) Performance and tuning

Use repeatable fixtures and thresholds:

- measure first flush, patch p95, long tasks
- monitor coalescing reduction
- compare branch vs baseline before release

See perf harness docs: [`/docs/perf-harness`](/docs/perf-harness)

## 11) Testing and regressions

Minimum quality bar:

- unit tests for parser + plugins
- HTML snapshot/regression checks
- deterministic replay checks in CI

See release checklist: [`/docs/release-checklist`](/docs/release-checklist)

## 12) Package and runtime matrix

Use the smallest surface area that fits each context:

- browser app: `stream-mdx` or `@stream-mdx/react` + worker asset
- node CLI/TUI: `stream-mdx/worker/node`
- protocol consumers: `@stream-mdx/protocol` and `@stream-mdx/tui`

## 13) Deployment and release workflow

Deployment flow:

1. build packages
2. build hosted worker
3. build docs app
4. run tests + link checks
5. deploy static output

For complete low-level details (including historical appendices and deep references), see the full source manual in the repo:

- `docs/COMPREHENSIVE_PROJECT_DOCUMENTATION.md`
