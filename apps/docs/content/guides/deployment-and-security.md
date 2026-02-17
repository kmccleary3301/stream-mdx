# Deployment and Security

## Hosted worker bundle

For production, host the worker bundle from static assets. This avoids `blob:` CSP requirements and keeps your policy strict.

```bash
mkdir -p public/workers
cp node_modules/@stream-mdx/worker/dist/hosted/markdown-worker.js public/workers/markdown-worker.js
```

Then point StreamMDX at it:

```tsx
<StreamingMarkdown worker="/workers/markdown-worker.js" />
```

## CSP guidance

If you serve the hosted bundle from your own origin, your CSP can be minimal:

```
worker-src 'self';
script-src 'self';
```

Avoid `blob:` unless you intentionally want to inline workers.

## HTML sanitization

HTML rendering uses a sanitizer with a default allowlist. This helps prevent unsafe tags or attributes from rendering.

If you need custom HTML, prefer `htmlElements` to keep the HTML surface small and auditable.

## Deployment checklist

- [ ] Host `markdown-worker.js` in a static directory.
- [ ] Set CSP `worker-src` to `self`.
- [ ] Use `mdxCompileMode="worker"` for parity.
- [ ] Enable `features.html` only if needed.

