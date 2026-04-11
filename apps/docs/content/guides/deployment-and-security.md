# Deployment and Security

This guide covers a production deployment pattern for StreamMDX with strict CSP, hosted worker assets, and controlled HTML rendering.

## Recommended production topology

1. Build your app and StreamMDX worker bundle in CI.
2. Copy `markdown-worker.js` into static assets.
3. Serve docs/app pages and worker from the same origin.
4. Keep CSP strict (`worker-src 'self'`) and avoid `blob:`.

```bash
mkdir -p public/workers
cp node_modules/@stream-mdx/worker/dist/hosted/markdown-worker.js public/workers/markdown-worker.js
```

Then reference it explicitly:

```tsx
<StreamingMarkdown worker="/workers/markdown-worker.js" />
```

## CSP baseline

A conservative baseline for most deployments:

```text
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
worker-src 'self';
connect-src 'self' https:;
```

Notes:

- `style-src 'unsafe-inline'` is often needed for runtime style injection in UI stacks.
- If your stack supports nonce-based styles, prefer nonce over unrestricted inline styles.

## HTML rendering policy

StreamMDX applies sanitization for untrusted HTML by default. Keep that enabled unless your input source is fully trusted and audited.

Operational policy:

- Enable `features.html` only when required.
- Prefer render-layer overrides (`htmlElements`) over sanitizer allowlist expansion.
- Review any allowlist changes as security-sensitive changes.

## MDX policy

MDX is code execution by design. Treat MDX input as trusted content unless you have a hardened compilation boundary.

- For user-generated content, keep `features.mdx` disabled.
- For trusted editorial content, enforce review + snapshot tests before publish.

## Release hardening checklist

- [ ] Hosted worker copied to static path and versioned with app deploy.
- [ ] CSP validated in production response headers.
- [ ] `features.html` and `features.mdx` configured intentionally (not accidental defaults).
- [ ] Regression snapshots updated and reviewed.
- [ ] Perf harness run attached to release notes.

## Incident response quick path

If a production issue appears in rendered output:

1. Disable risky feature flag (`html` or `mdx`) first.
2. Roll back to previous worker bundle + app release.
3. Compare regression snapshots to isolate the rendering delta.
4. Patch and redeploy with a new snapshot/perf report.

## Vercel notes

For this monorepo docs app on Vercel:

- Root Directory: `apps/docs`
- Build Command: `cd ../.. && npm run docs:build`
- Install Command: `cd ../.. && npm ci`
- Output Directory: `apps/docs/out`
- Include files outside root directory: **Enabled**

This is required so Vercel can access workspace packages and build the hosted worker.

## Custom domain verification

If you attach a custom domain such as `stream-mdx.dev`, verify all of this after the DNS change:

- apex domain serves valid HTTPS without certificate or handshake errors
- `www` either serves cleanly or redirects to the chosen canonical hostname
- the docs app and `/workers/markdown-worker.js` stay on the same expected origin
- the exported site still builds and serves correctly after the domain cutover
- CSP still permits the hosted worker source you actually ship

Treat a broken TLS handshake as a deployment failure even if DNS already resolves. DNS propagation alone is not enough.
