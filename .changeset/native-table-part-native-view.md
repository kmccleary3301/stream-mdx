---
"@stream-mdx/react": minor
"stream-mdx": minor
---

Export `NativeNodeView` from `@stream-mdx/react/server` so headless views rendered by the server `MarkdownBlocksRenderer` can fall back to native output. `table-row`, `table-cell` and `component:<Name>` presentations accept only `wrapper` and `props`, both in the types and at `ComponentRegistry` construction; customize tables headlessly through `components.table.view` with `useTableBlock` and `useTableRows`.
