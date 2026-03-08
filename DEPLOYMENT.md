# StreamMDX Docs Deployment (Vercel)

This project deploys the docs site as a static export.

## Vercel project settings

- Root Directory: `stream-mdx`
- Build Command: `npm run docs:build`
- Output Directory: `apps/docs/out`
- Install Command: default (`npm install`)
- Node.js version: 20 (matches CI; see `.nvmrc`)

## Notes

- The docs app uses `output: "export"` in `apps/docs/next.config.mjs`, so Vercel must serve the exported static output.
- `docs:build` runs:
  - `docs:worker:build` to build + copy the hosted worker into `apps/docs/public/workers/markdown-worker.js`
  - `docs:snapshots:build` to precompile markdown into snapshot artifacts
  - `next build` (static export) for `apps/docs/out`
- Snapshot artifacts are written to `apps/docs/.generated/snapshots/**` and are consumed by docs routes at build/runtime.
- Snapshot cache invalidation includes the hosted worker bundle hash, so changing worker output (e.g. Mermaid/code handling) forces a rebuild of artifacts.
- Trailing slashes are enabled; static routes should be tested with `/path/` in static export mode.

## Edge / no-worker runtime note

For runtimes that cannot spawn `worker_threads`, use:

- `stream-mdx/worker/direct` (or `@stream-mdx/worker/direct`) for deterministic snapshot compile
- `@stream-mdx/react/server` to render `Block[]` output

Direct compile cache behavior:
- In Node-like runtimes with filesystem APIs, `compileMarkdownSnapshotDirect()` supports the same snapshot cache contract as `compileMarkdownSnapshot()`.
- In edge isolates without filesystem access, direct compile still works and cache IO is skipped.

## Local verification

From `stream-mdx/`:

```
npm run docs:build
npm run docs:check-links
```

Emulate a Vercel-style build from a clean directory copy (recommended):

```
npm run vercel:parity
```

Then serve the static output:

```
python3 -m http.server 3010 --bind 127.0.0.1 --directory apps/docs/out
```

Optional: capture screenshots (fails on console errors, runtime overlays, blank pages, and missing Mermaid SVG):

```
CAPTURE_WAIT_MS=2500 CAPTURE_FULL_PAGE=1 npx tsx scripts/capture-docs-screenshots.ts
```

Or use the repo scripts:

```
npm run docs:screenshots
npm run docs:screenshots:smoke
```

Smoke-check:
- `/`
- `/docs/getting-started/`
- `/docs/tui-json-protocol/`
