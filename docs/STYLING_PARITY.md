# Styling parity & diffing

This repo maintains a “blog-like” docs + demo site under `apps/docs` that intentionally mirrors the look-and-feel of the original ql-homepage streaming demo.

## Source-level diffs

- Global site chrome + theme variables live in `apps/docs/app/globals.css`.
- Markdown typography + element spacing live in `apps/docs/app/markdown.css` and `apps/docs/app/prose.css`.

To diff changes between commits:

- `git diff -- apps/docs/app/globals.css apps/docs/app/markdown.css apps/docs/app/prose.css`

## Compiled CSS snapshot diffs

When you want to diff “what the browser actually gets”, snapshot the built CSS bundle and compare snapshots.

1. Build the docs site:
   - `npm run docs:build`
2. Snapshot the compiled CSS into `tmp/css-snapshots/`:
   - `npm run docs:css:snapshot`
3. Compare snapshots across commits:
   - `git diff --no-index tmp/css-snapshots/docs-<shaA>.css tmp/css-snapshots/docs-<shaB>.css`

Notes:

- The snapshot concatenates `apps/docs/out/_next/static/css/*.css` in filename order and annotates each chunk with its source filename so diffs remain readable even though filenames are hashed.

## Component-level CSS diffs (computed styles)

If you need “diff CSS for one component” (e.g. code blocks only), the clean approach is to:

1. Render a known fixture page (example: `/demo`).
2. Use a browser automation tool (Playwright recommended) to query for specific selectors and dump `getComputedStyle(...)` results into JSON.
3. Diff the JSON outputs across commits.

This avoids chasing hashed CSS files and directly answers “what changed visually for this element?”.

