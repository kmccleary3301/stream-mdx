# Streaming Markdown Starter

This example mirrors the quick-start instructions in `docs/GETTING_STARTED.md`. It is intentionally minimal so you can copy/paste the folder into a fresh Next.js project or run it in-place for manual testing.

## Usage

```bash
cd stream-mdx/examples/streaming-markdown-starter
npm install
# Build + copy the hosted worker bundle from the repo root first:
cd ../../
npm run worker:build
cd examples/streaming-markdown-starter
npm run dev
```

Then open http://localhost:3000 to stream the sample article. Use the dropdown to switch between server-side and worker-side MDX compilation modes and type into the textarea to simulate live updates.

> Set `NEXT_PUBLIC_STREAMING_WORKER_HELPER=true` in `.env.local` if you want the starter to instantiate the worker via `createDefaultWorker()` (the same helper used by the React package).

> This repo uses npm workspaces, so the starter depends on `stream-mdx` via workspace resolution. If you copy this folder into a standalone app, update the dependency versions to match the published packages.
