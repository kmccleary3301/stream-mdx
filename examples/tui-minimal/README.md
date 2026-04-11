# Minimal TUI Example

This directory is the smallest end-to-end StreamMDX terminal example in the repo.

It demonstrates:

- worker-thread parsing via `stream-mdx/worker/node`
- patch application with `@stream-mdx/tui`
- terminal rendering from materialized `Block[]`

## Run

From the repo root:

```bash
npm install
npm run build:packages
npm run example:tui-minimal
```

## What the example does

1. starts the StreamMDX worker in Node
2. initializes document plugins
3. appends markdown in timed chunks
4. applies `PATCH` messages to the TUI snapshot store
5. clears the terminal and renders the current `Block[]`

## Scope

This is intentionally minimal.

It does **not** try to:

- render ANSI syntax-highlighted tokens
- preserve scrollback
- render arbitrary MDX components in a terminal
- implement an Ink/blessed layout system

Use it as:

- a copy/paste starting point
- a sanity check for `@stream-mdx/tui`
- a reference for the architecture described in [`../../docs/TUI_GUIDE.md`](../../docs/TUI_GUIDE.md)

If you want the docs-site version of this walkthrough, read [`../../docs/TUI_MINIMAL_EXAMPLE.md`](../../docs/TUI_MINIMAL_EXAMPLE.md).
