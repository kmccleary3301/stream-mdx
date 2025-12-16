# Streaming Markdown Starter

This example mirrors the quick-start instructions in `docs/STREAMING_MARKDOWN_QUICKSTART.md`. It is intentionally minimal so you can copy/paste the folder into a fresh Next.js project or run it in-place for manual testing.

## Usage

```bash
cd stream-mdx/examples/streaming-markdown-starter
npm install
# Build the worker bundle from the repo root first:
npm run worker:build
cp ../../public/workers/markdown-worker.js public/workers/
npm run dev
```

Then open http://localhost:3000 to stream the sample article. Use the dropdown to switch between server-side and worker-side MDX compilation modes and type into the textarea to simulate live updates.

> Set `NEXT_PUBLIC_STREAMING_WORKER_HELPER=true` in `.env.local` if you want the starter to instantiate the worker via `createDefaultWorker()` (the same helper used by the React package).

> The package.json links the local `@stream-mdx/*` workspaces via `file:../../packages/...`. Update the versions if you publish the packages to npm.
