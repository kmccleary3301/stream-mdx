---
"@stream-mdx/react": patch
---

Preserve the detached visible table row and its pixel offset when measured row heights change, including rows partly covered by the sticky header. Keep bottom-following behavior for attached viewports. Reset the viewport and discard its geometry when the root source document is replaced, while retaining anchors across same-document appends.

Add an accessible per-table "Show full content" toggle for virtualized tables. It mounts all rows only on request and restores bounded windowing while retaining the native viewport, table, selection endpoints, measured columns, and scroll position.

Native table Markdown copy and download use the owned authored source slice, preserving spacing, escapes, inline Markdown, and original line endings while excluding the final row's line ending and following document content. TSV and CSV remain cell-value transforms. The public consumer regression clicks the copy button in JSDOM with a stubbed Clipboard API; it does not verify a physical browser or OS clipboard. Markdown download shares the source-selection path, but its Blob/browser handoff, PDF, and speech output were not exercised.
