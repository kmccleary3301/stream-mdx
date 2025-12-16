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

- Build: `npm run markdown-v2:build:packages`
- Tests: `npm run markdown-v2:test:packages`
- Release verify (tarballs + starter build): `npm run markdown-v2:release:verify`
