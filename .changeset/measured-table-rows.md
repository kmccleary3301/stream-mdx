---
"@stream-mdx/react": minor
---

Add opt-in virtualization for large finalized tables. Mounted rows use ResizeObserver measurements, stable row IDs, native sticky headers, and bounded overscan. Server rendering and unfinished streams retain every row. Updating or removing the tableVirtualization prop updates the mounted view.
