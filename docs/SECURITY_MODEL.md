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

### MDX evaluation and `script-src` (`unsafe-eval`)

StreamMDX's core markdown and plugin pipeline does not require `unsafe-eval`. However, **client-side MDX evaluation** compiles and evaluates component code in the browser via `new Function(...)` (`mdx-client.ts`), which **requires `unsafe-eval`** in your host application's Content Security Policy (`script-src 'self' 'unsafe-eval'`).

If your application operates under a strict CSP that forbids `unsafe-eval`:
- Disable MDX features (`features={{ mdx: false }}`), or
- Pre-compile MDX server-side into static components rather than evaluating dynamic MDX strings in the client.

## Artifact Sandbox Model (P4)

StreamMDX provides built-in sandboxing for interactive HTML artifacts (languages `artifact`, `html-artifact`, and opt-in `html` via `artifactHtml: true`):

### 1. Hardened iframe isolation
- **No `allow-same-origin`**: Finalized artifacts mount inside an `<iframe sandbox="allow-scripts" srcdoc="...">`. Because `allow-same-origin` is omitted, the artifact executes in an opaque unique origin with zero access to the host page's DOM, cookies, `localStorage`, `sessionStorage`, or auth tokens.
- **Streaming safety**: During streaming while the block is dirty (`isFinalized === false`), the artifact displays as an inert code block. The iframe is only mounted once the code block is finalized.

### 2. In-frame Content Security Policy (CSP)
Every artifact `srcdoc` includes a strict `<meta http-equiv="Content-Security-Policy">`:
- `default-src 'none'`
- `connect-src 'none'` by default (prevents data exfiltration; allowlists can be configured via `csp.connectSrc`)
- `script-src 'unsafe-inline'` + configured allowlist
- `style-src 'unsafe-inline'` + configured allowlist
- `img-src data: blob:` + configured allowlist
- `font-src data:` + configured allowlist

### 3. Secure host communication
- **Origin and window verification**: The artifact communicates with the host window via `postMessage`. The host listener verifies that `event.source === iframeRef.current.contentWindow`. Foreign-source messages and spoofed dimensions are ignored.
- **Safe navigation**: Navigation links clicked inside the artifact are prevented, posted to the host via `stream-mdx:artifact-link`, validated through the host's `linkSafety` policy, and opened with `rel="noopener,noreferrer"` in a new browsing context.
## Reporting security issues

See the repo root `SECURITY.md` once added.

