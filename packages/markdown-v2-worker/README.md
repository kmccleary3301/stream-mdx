# `@stream-mdx/worker`

Worker client utilities and hosted worker bundle used by StreamMDX.

Most consumers interact with this package indirectly via `<StreamingMarkdown />`. You only need `@stream-mdx/worker` directly if you want explicit control over worker instantiation, MDX compilation parity helpers, or strict CSP setups.

## Install

```bash
npm install @stream-mdx/worker
```

## Hosted worker bundle (recommended)

For production, host the worker bundle from static assets (avoids `blob:` CSP requirements):

```bash
mkdir -p public/workers
cp node_modules/@stream-mdx/worker/dist/hosted/markdown-worker.js public/workers/markdown-worker.js
```

Then point StreamMDX at it:

```tsx
<StreamingMarkdown worker="/workers/markdown-worker.js" />
```

## MDX compilation parity helper

If you compile MDX on the server (e.g. Next.js API route), use the same compilation logic as the worker:

```ts
import { compileMdxContent } from "@stream-mdx/worker/mdx-compile";
```

See `docs/REACT_INTEGRATION_GUIDE.md` for the full wiring and parity notes.

## Docs

- React integration guide: `docs/REACT_INTEGRATION_GUIDE.md`
- Security model / CSP: `docs/SECURITY_MODEL.md`
- Plugins & custom worker bundles: `docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`
