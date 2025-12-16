# StreamMDX

Streaming Markdown/MDX rendering for React with worker-first parsing, incremental patching, and perf guardrails.

This folder is the extracted library workspace inside the staging repo.

## Packages

- `stream-mdx` (convenience wrapper; re-exports the React surface)
- `@stream-mdx/core`
- `@stream-mdx/react`
- `@stream-mdx/worker`
- `@stream-mdx/plugins`

## Install (eventual npm)

- Simple: `npm i stream-mdx`
- Modular: `npm i @stream-mdx/react @stream-mdx/worker @stream-mdx/plugins @stream-mdx/core`

## Local dev (from this repo)

- Install: `npm install`
- Build all packages: `npm run build` (alias: `npm run markdown-v2:build:packages`)
- Run package tests: `npm run test` (alias: `npm run markdown-v2:test:packages`)

Notes:
- This workspace uses **npm workspaces**. The starter app (`examples/streaming-markdown-starter`) consumes packages by matching workspace versions (currently `0.0.0`).
- Several internal benchmarking/analyzer scripts referenced in `docs/` still live in the parent app repo for now (they expect a richer demo harness than the starter).
