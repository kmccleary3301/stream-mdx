---
"@stream-mdx/react": patch
---

Render public `NativeNodeView` fallbacks for headless table-row and table-cell presentations without breaking native table nesting.

`NativeNodeView` is also exported from `@stream-mdx/react/server`, so headless views rendered by the server `MarkdownBlocksRenderer` can fall back to native output.
