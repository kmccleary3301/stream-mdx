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

The default `contentPolicy` is `"restricted"`. Markdown and restricted parsing do not evaluate authored code. Under restricted policy, use the `defineContentComponent` factory to register source names; raw constructors are not registrations. A type-predicate `validateProps` is required when narrowing the source JSON props, while the broad JSON-props overload may omit it. The worker receives only serializable `name` and `renderWhen` descriptors; validators and components stay on the host. Native projected `children` are supplied separately as host React nodes, not taken from source JSON. This registry is active only under `"restricted"` policy, not `"markdown"` or `"trusted-mdx"`.

Quoted attributes preserve literal backslashes and decode HTML entities; only brace-delimited strict JSON decodes backslash escapes. The complete validated opening fixes the source props. Admitted JSON is recursively frozen again after worker transport, before host validation, and the React props envelope is frozen in production as well. Native React children are not recursively frozen with source data.

`renderWhen: "closed"` suppresses only a component whose native status is open. A finalized incomplete body that passes validation remains rendered with its diagnostic; an incomplete opening header remains literal and does not invoke a host callback.

Registered components retain native Markdown owners in paragraphs, headings, quotes, lists and sanitized HTML. Emphasis and visible link text may contain components without splitting the surrounding inline grammar. Tag spellings inside code, link destinations or titles, image alt text, comments and HTML attributes remain native data, never component registrations. Entity-encoded text cannot forge an admission marker.

Whole-list inline admission retains one native inline scope across component leaves and uses the configured HTML tag and attribute policy. Native inline renderers and element filters receive the actual recursive parent tag; component ownership does not reactivate disabled autolink protocols. Each prepared owner publishes one active HTML tree, so formatting and footnote numbering read the same meaning rather than a stale fallback copy.

The public React host handle's `finalize()` synchronously seals APPEND admission for every `contentPolicy`. Source accepted before the host seal drains; later host `append()` calls fail with `StreamSessionError` reason `"sealed"`. Repeated calls in one host generation return the same promise. The promise resolves to `FinalizeResult` with the host generation and accepted/committed source-unit counts; reset or replacement opens the next host generation. This does not change raw `MarkdownEngine`, `MarkdownWorkerClient`, or worker-protocol controls; those lower-level APIs do not use the host admission ledger or finalization promise. Automatically owned worker restarts may queue host appends and finalization before readiness for the matching fresh generation; a later restart invalidates requests for an earlier host generation. A managed worker's host remains responsible for its initialization.

Full MDX evaluation is available only through an explicit `createTrustedMdxEngine` from `@stream-mdx/react/trusted-mdx`, passed with `contentPolicy="trusted-mdx"` and `engines.mdx`. It evaluates a complete authored document revision in the host realm with `AsyncFunction`, which requires `unsafe-eval` in the host application's `script-src`. Its `imports` map is an explicit host capability map from authored module specifiers to supplied bindings; unresolved imports fail, and modules are never fetched automatically. This is not a sandbox. Use it only for trusted, reviewed content.

The host `finalize()` promise resolves only after the matching native `FINALIZED` acknowledgement covers accepted session units and semantic patches have flushed into the renderer store. This is a native semantic-store barrier, not a React DOM-commit or optional-enrichment barrier: it does not await trusted compilation or projection, code highlighting/tokenization, or optional decoration. The trusted document snapshot distinguishes the requested revision, projected candidate revision, and revision actually rendered. A candidate is committed only after the host confirms its render. Lease, request, and engine-generation checks reject stale async compilation results and run immediately before authored module evaluation; newer revisions, `clear`/cache invalidation, or disposal invalidate old work. Disposal is terminal. A render failure can restore the last actually committed UI, but cannot roll back side effects already caused by trusted authored code.
For a controlled replacement, the renderer captures one immutable prepared native store once after each successful complete-module host commit. If the next revision is pending or fails to render, the old frame stays labelled with its source generation and document revision; its code decorations remain at commit-time freshness while later enrichment updates only the live store. The retained frame does not send code jobs to the current worker and is released on reset, engine/cache invalidation or disposal, lease or policy change, or a later successful commit. A retained React render error shows the captured source and error, but cannot undo arbitrary trusted host effects.

JSX/MDX source-span discovery in the native worker is parse-only; it does not import the trusted compiler or evaluate a module. In a successfully compiled trusted revision, compiler-authored module ranges suppress the entire contained native declaration block, not only embedded expression leaves. Ordinary restricted Markdown keeps its literal source behavior.

If your CSP forbids `unsafe-eval`, keep full MDX disabled. Use the restricted content policy and native `contentComponents`, or publish pre-rendered static output.

## Artifact-like code fences

Fences labeled `artifact` or `html-artifact` render as ordinary code unless `components.code.wrapper` explicitly routes them elsewhere. StreamMDX no longer provides a default artifact frame or iframe sandbox. A custom presentation that activates source content is application code; the host must define and review that boundary.

## Reporting security issues

See the repo root `SECURITY.md` once added.

## Production verification

When you change worker hosting or attach a custom domain, verify:

- hosted worker URL still resolves from the same intended origin
- HTTPS is valid on the final public hostname
- `worker-src` matches the actual production worker source
- no fallback to `blob:` or looser CSP was introduced accidentally
