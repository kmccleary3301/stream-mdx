---
"@stream-mdx/core": patch
"@stream-mdx/react": patch
"@stream-mdx/unified": patch
---

Security hardening: render-time URL transformation across client and SSR, raw HTML attribute and style sanitization, unified HAST URL sanitization, and ArtifactFrame height validation.

- `@stream-mdx/core`: Replaced dead URL sanitization code with `defaultUrlTransform(url, attribute, context)` which sanitizes URLs for `href` and `src` attributes. Rejects `javascript:`, `vbscript:`, `file:`, and unapproved `data:` URLs (allowing only `data:image/(png|gif|jpeg|webp|avif)` on `src`), while permitting relative paths, fragments, and custom schemes so CommonMark conformance stays at 675/675. In HTML schemas, `on*` event handlers and `srcdoc` attributes are strictly forbidden regardless of user `allowedTags` configuration, and `script` tags are never permitted. Exported `sanitizeStyle` for DOM-free CSS style sanitization.
- `@stream-mdx/react`: Added `urlTransform` prop to `<StreamingMarkdown />`, `ComponentRegistry`, and `MarkdownBlocksRenderer`. Applied at render time across link and image node views, raw HTML attributes (`href`, `src`, `action`, `formaction`, `xlink:href`), SSR rendering, and `openLink`/`linkSafety` navigation (preventing unsafe scheme execution). Raw HTML `style` attributes now enforce the DOM-free CSS property allowlist (dropping `position`, `url()`, backslash escapes, and expressions while retaining colors and fonts). `ArtifactFrame` strictly verifies `Number.isFinite(data.height)` and clamps between 50 and 10000 px, ignoring `NaN` and `Infinity`.
- `@stream-mdx/unified`: Added `urlTransform` option to `createUnifiedRenderer` that applies URL sanitization via a final HAST transformation pass after user rehype plugins without stripping user classes.
