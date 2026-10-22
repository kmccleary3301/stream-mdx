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

Code-row HTML emitted by the syntax highlighter (per-line `span.line` markup with Shiki theme variables) uses one shared allowlist on every runtime: `pre`/`code`/`span`/`div`/`br` with `class`, `data-*`, and `style` attributes. The browser path runs that allowlist through DOMPurify; the Node/SSR path (snapshot prerender, `MarkdownBlocksRenderer`) runs it through the DOM-free rehype pipeline, so no `window`/jsdom shim is required. Surviving style declarations must use an allowed presentational property (theme foreground/background colors, font emphasis, `--shiki-*` variables) and an ASCII value from a conservative charset, so CSS backslash escapes, comment-splitting tricks, and function values such as `url(...)`/`expression(...)` are dropped on both paths while theme foreground colors and CSS variables are preserved. Tags whose content is never unwrapped (`svg`, `template`, `iframe`, `math`, `thead`, `title`, …) follow DOMPurify's forbidden-contents set on both paths, so an `<svg><text>…</text></svg>` subtree disappears identically in the browser and during prerender, while other disallowed tags (for example `em` or a stray `textarea`) are unwrapped and keep their text on both paths.

## MDX policy

MDX execution is opt-in. `contentPolicy` defaults to `"restricted"` and does not evaluate authored expressions. Register fixed native source components with `defineContentComponent` in `contentComponents`; the worker receives only names and render conditions, while validators and component callbacks remain on the host. Native projected children are separate React nodes. This registry is inactive under `"markdown"` and `"trusted-mdx"`.

Full MDX requires an explicit `createTrustedMdxEngine` from `@stream-mdx/react/trusted-mdx`, passed with `contentPolicy="trusted-mdx"` and `engines.mdx`. The host import map grants explicit module bindings only; unresolved imports are not fetched. Evaluation runs authored code in the host realm, requires `unsafe-eval` in `script-src`, and is not a sandbox. Use it only for trusted, reviewed content. For user-generated input, keep the restricted policy and leave `engines.mdx` unset.

Native worker `FINALIZED` reports native semantic completion, not trusted compilation or host render readiness. The trusted document distinguishes requested, projected, and actually rendered revisions; lease/request/engine checks reject stale work before evaluation. A failed render may restore prior committed UI, but cannot undo side effects from code that already executed.

## Agent content and code renderers

For agent or user content, disable raw HTML unless needed and keep full MDX evaluation off. Set `features.mdx: false` if the feed does not need component syntax. Enable `linkSafety` for links rendered by StreamMDX; it does not control navigation from custom renderers.

Fences labeled `artifact` or `html-artifact` render as code by default. StreamMDX does not provide a built-in artifact iframe or sandbox. Do not map untrusted content to an execution-capable renderer unless your application supplies and reviews its own isolation and security policy.

### Safe defaults for agent content

1. Keep `contentPolicy="restricted"` and do not supply a trusted MDX engine for untrusted source.
2. Set `features.html: false` unless the feed needs sanitized raw HTML.
3. Use `linkSafety: { enabled: true }` for Markdown links. It does not mediate every navigation initiated by custom output.

### Replacing and customizing codeRenderers

StreamMDX engine-v2 allows granular code fence renderer customization via the `codeRenderers` prop. You can map specific fence languages to specialized renderers while letting standard code blocks use the default highlighter:

```tsx
import { StreamingMarkdown, type CodeFenceRenderer } from "@stream-mdx/react";
import { MermaidBlock } from "@stream-mdx/mermaid";

const CustomMetricRenderer: CodeFenceRenderer = ({ code, language, isFinalized, renderCode }) => {
  try {
    const data = JSON.parse(code);
    return (
      <div className="metric-panel">
        <span className="badge">{isFinalized ? "Finalized" : "Streaming..."}</span>
        <pre>{JSON.stringify(data, null, 2)}</pre>
      </div>
    );
  } catch {
    return <>{renderCode}</>;
  }
};

export function AgentChatStream({ text }: { text: string }) {
  return (
    <StreamingMarkdown
      text={text}
      engine="worker" // or "main-thread"
      features={{ mdx: false, html: false, tables: true, math: true }}
      linkSafety={{ enabled: true }}
      codeRenderers={{
        mermaid: MermaidBlock,
        metric: CustomMetricRenderer,
      }}
    />
  );
}
```

See the runnable chat-thread demonstration at [`/showcase/assistant-stream`](/showcase/assistant-stream).

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
