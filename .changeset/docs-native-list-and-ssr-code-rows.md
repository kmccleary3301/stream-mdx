---
"@stream-mdx/core": patch
---

Sanitize finalized code-row HTML without a DOM. `sanitizeCodeHTML` now reuses the shared DOM-free rehype pipeline (`CODE_ROW_ALLOWED_TAGS`/`CODE_ROW_ALLOWED_ATTRS`) when `window` is unavailable, so Node/SSR prerender (Next static export, snapshot stores, `MarkdownBlocksRenderer`) renders Shiki line markup and theme CSS variables instead of throwing, and malformed/untrusted row markup still loses scripts, event handlers, `javascript:` URLs, and unsafe style declarations. The browser DOM path applies the same allowlist and the same allowlisted-property/ASCII-charset style policy (rejecting CSS backslash escapes, comment-splitting, and function values such as `url(...)`), so browser and Node code-row DOM semantics match.
