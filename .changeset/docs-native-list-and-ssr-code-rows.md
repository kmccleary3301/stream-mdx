---
"@stream-mdx/core": patch
"@stream-mdx/react": patch
---

Sanitize finalized code-row HTML without a DOM. `sanitizeCodeHTML` now reuses the shared DOM-free rehype pipeline (`CODE_ROW_ALLOWED_TAGS`/`CODE_ROW_ALLOWED_ATTRS`) when `window` is unavailable, so Node/SSR prerender (Next static export, snapshot stores, `MarkdownBlocksRenderer`) renders Shiki line markup and theme CSS variables instead of throwing, and malformed/untrusted row markup still loses scripts, event handlers, `javascript:` URLs, and unsafe style declarations. The browser DOM path applies the same allowlist and the same allowlisted-property/ASCII-charset style policy (rejecting CSS backslash escapes, comment-splitting, and function values such as `url(...)`), so browser and Node code-row DOM semantics match.

`ComponentRegistry.hasCustomBlockComponent` now reports a block type as custom only when the registered component differs from the built-in default. Re-passing the built-in component map (`components={registry.getBlockComponentMap()}`, the docs harness shape) keeps native block views enabled, so nested list children and nested code fences render instead of flattening through the default list component. Mid-stream fallback code lines are joined with newlines, so streamed `pre code` text stays a strict logical prefix of the finalized fence source.
