# StreamMDX

High-performance streaming Markdown/MDX renderer for React with worker-first parsing, incremental patching, and backpressure guardrails.

[![npm version](https://img.shields.io/npm/v/stream-mdx)](https://www.npmjs.com/package/stream-mdx)
[![CI](https://github.com/kmccleary3301/stream-mdx/actions/workflows/ci.yml/badge.svg)](https://github.com/kmccleary3301/stream-mdx/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/stream-mdx)](https://github.com/kmccleary3301/stream-mdx/blob/main/LICENSE)
[![docs](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://kmccleary3301.github.io/stream-mdx/)

## Install

```bash
npm install stream-mdx
```

## Quickstart

### 1) Copy the hosted worker bundle

```bash
mkdir -p public/workers
cp node_modules/@stream-mdx/worker/dist/hosted/markdown-worker.js public/workers/markdown-worker.js
```

### 2) Render

```tsx
"use client";

import { StreamingMarkdown } from "stream-mdx";

export function Demo({ text }: { text: string }) {
  return <StreamingMarkdown text={text} worker="/workers/markdown-worker.js" />;
}
```

## Packages

- `stream-mdx` (recommended for apps)
- `@stream-mdx/{core,react,worker,plugins}` (modular building blocks)
- `@stream-mdx/mermaid` (optional Mermaid diagram addon)

## Docs

- Docs site: https://kmccleary3301.github.io/stream-mdx/
- Start here: `docs/README.md`
- API: `docs/PUBLIC_API.md`
- React patterns: `docs/REACT_INTEGRATION_GUIDE.md`
- Plugins/worker cookbook: `docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`
- Release checklist: `docs/STREAMING_MARKDOWN_RELEASE_CHECKLIST.md`

## Local development

- Install: `npm install`
- Build: `npm run build`
- Test: `npm test`
- Pack+install smoke test: `npm run ci:pack-smoke`

See `CONTRIBUTING.md` for more.
