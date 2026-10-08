---
"@stream-mdx/react": minor
---

Add element filtering, code renderer aliases, and autolink protocol disabling:
- `allowedElements` and `disallowedElements` to filter HTML tag names at render time across markdown and raw HTML (mutually exclusive, validation error in development if both are supplied).
- `allowElement` callback predicate `(element, context) => boolean` receiving `{ tagName, properties, blockType? }` and `{ source: "markdown" | "html", parentTagName? }`.
- `unwrapDisallowed` boolean to unwrap and render children of disallowed elements in place instead of dropping the subtree.
- Unified element decision function in `ComponentRegistry` applied across client node views, SSR, and raw HTML rendering.
- `codeRenderers` support for language aliases via `{ language: string | string[], component }` and `{ languages: string[], renderer }`, resolved case-insensitively.
- `disableAutolinkProtocols` to render autolink literals and angle autolinks with specific protocols (e.g. `["mailto"]`) as plain text while preserving explicit markdown links.
