# Security Model (HTML + CSP)

## HTML is an XSS surface

If you enable raw/inline HTML (`features.html`), treat the input as untrusted by default:

- Keep sanitization enabled.
- Prefer hosted workers (parsing off the main thread; clearer CSP posture).
- Only extend allowlists/schemas for content you trust.

### URL Sanitization Policy

StreamMDX sanitizes URLs at render-time using `@stream-mdx/core`'s `defaultUrlTransform(url, attribute, context)`. This policy is uniformly applied to:
- Markdown link destinations (`[text](url)`) and image sources (`![alt](url)`).
- Raw HTML attributes: `href`, `src`, `action`, `formaction`, and `xlink:href`.
- Client-side interactive rendering, server-side rendering (SSR), unified HAST post-processing, and link navigation callbacks (`openLink`, `linkSafety`).

**Scheme verification rules:**
- Leading and internal ASCII whitespace and control characters are stripped and HTML entities are decoded before scheme detection, preventing filter bypasses (e.g. `java\0script:`, ` jav&#x09;ascript:`).
- Potentially dangerous schemes are rejected (returning `null`, causing the attribute to be omitted from the output markup): `javascript:`, `vbscript:`, `file:`, and unapproved `data:` URLs.
- For `src` attributes exclusively, safe image data schemes (`data:image/png`, `data:image/gif`, `data:image/jpeg`, `data:image/webp`, and `data:image/avif`) are permitted; all other `data:` URLs (including `data:text/html` and SVG) are rejected.
- Relative paths, fragment identifiers (`#`), and custom application schemes (e.g. `intent:`, `myapp:`) are permitted, preserving strict CommonMark specification conformance (675/675).
- Callers can customize URL rewriting and filtering via the `urlTransform` prop on `<StreamingMarkdown />`, `ComponentRegistry`, and `createUnifiedRenderer()`. A rejected URL never executes or navigates.

### Raw HTML Attribute & Style Hardening

When `features.html` is enabled:
- **Forbidden Attributes**: Attribute names beginning with `on*` (such as `onclick`, `onload`, `onerror`) and `srcdoc` are strictly forbidden and always stripped by the sanitizer and React renderer, regardless of whether a consumer configures them in `html.allowedTags`.
- **Forbidden Tags**: `<script>` tags are strictly excluded and never executed.
- **CSS Style Sanitization**: Raw HTML `style` attributes are sanitized using a DOM-free allowlist parser. Declarations with dangerous properties (`position`, `behavior`, etc.), functions (`url(...)`, `expression(...)`), backslash escapes, or multi-line comment tricks are dropped, while safe formatting declarations (`color`, `font-size`, `background-color`, `border`, etc.) are retained.

### Highlighter Code-Row Sanitization

Highlighter code-row HTML (per-line `span.line` markup with Shiki theme variables) is sanitized on every runtime with one shared allowlist: `pre`/`code`/`span`/`div`/`br` with `class`, `data-*`, and `style`. The browser path runs it through DOMPurify; the Node/SSR path (snapshot prerender, `MarkdownBlocksRenderer`) runs the same allowlist through the DOM-free rehype pipeline, so server rendering needs no `window`/jsdom shim. Scripts, event handlers, `javascript:` URLs, and `url(...)`/`expression(...)` style values are dropped on both paths while theme foreground colors and CSS variables are preserved.
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
- `connect-src 'none'` by default blocks connection APIs such as `fetch`, `XMLHttpRequest`, and `WebSocket`; allowlists can be configured via `csp.connectSrc`.
- `script-src 'unsafe-inline'` + configured allowlist
- `style-src 'unsafe-inline'` + configured allowlist
- `img-src data: blob:` + configured allowlist
- `font-src data:` + configured allowlist
- `base-uri 'none'`, `form-action 'none'`

The policy, theme styles, and bootstrap script are written before any artifact markup, so a full artifact document (with its own `<!doctype>`, `<html>`, `<head>`) cannot run script ahead of the policy.

The sandbox provides host DOM/origin isolation, and the default CSP restricts connections and resource loads. These controls do not guarantee total network isolation or prevent iframe self-navigation. Use self-contained artifact content. The link handler below covers intercepted anchor clicks, not every navigation a script can initiate.

### 3. Secure host communication
- **Origin and window verification**: The artifact communicates with the host window via `postMessage`. The host listener verifies that `event.source === iframeRef.current.contentWindow`. Foreign-source messages and spoofed dimensions are ignored. Resizing messages (`stream-mdx:artifact-size`) strictly validate `Number.isFinite(data.height)` and clamp accepted values between 50px and 10,000px, ignoring `NaN`, `Infinity`, or negative dimensions.

## Reporting security issues

See the repo root `SECURITY.md` once added.

## Production verification

When you change worker hosting or attach a custom domain, verify:

- hosted worker URL still resolves from the same intended origin
- HTTPS is valid on the final public hostname
- `worker-src` matches the actual production worker source
- no fallback to `blob:` or looser CSP was introduced accidentally
