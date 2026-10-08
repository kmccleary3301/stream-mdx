---
"@stream-mdx/react": minor
---

Add opt-in virtualization for large finalized tables in inactive streaming sessions. Preserve natural column widths with measured columns and a full-table sizing pass on viewport resize. Mounted rows use ResizeObserver measurements, stable row IDs, opaque sticky headers, and bounded overscan. Existing overflow-wrapped Table adapters use one managed scroll viewport with scoped style cleanup. Server rendering and active async/imperative sessions retain every row. Updating or removing the tableVirtualization prop updates the mounted view.
