# Security Model (HTML + CSP)

## HTML is an XSS surface

If you enable raw/inline HTML (`features.html`), treat the input as untrusted by default:

- Keep sanitization enabled.
- Prefer hosted workers (parsing off the main thread; clearer CSP posture).
- Only extend allowlists/schemas for content you trust.

## CSP recommendations

### Prefer hosted workers

Host the worker bundle and point StreamMDX at it:

```tsx
<StreamingMarkdown worker="/workers/markdown-worker.js" />
```

This avoids needing to allow `blob:` in `worker-src`/`script-src`.

### Avoid `unsafe-eval`

StreamMDX does not require `unsafe-eval` for its core pipeline. If your MDX components embed third-party scripts, treat those as a separate surface and lock them down per-component.

## Reporting security issues

See the repo root `SECURITY.md` once added.

