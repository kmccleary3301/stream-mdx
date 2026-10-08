---
"@stream-mdx/react": minor
---

Add opt-in virtualization for large finalized tables in inactive streaming sessions. Preserve natural column widths with measured columns and a full-table sizing pass on viewport resize. Mounted rows use ResizeObserver measurements, stable row IDs, opaque sticky headers, and bounded overscan. Existing overflow-wrapped Table adapters use one managed scroll viewport with scoped style cleanup. Server rendering and active async/imperative sessions retain every row. Updating or removing the tableVirtualization prop updates the mounted view.

Finalize async iterator tails on normal EOF and track iterator ownership independently of stream prop presence. Refresh table observers and measurements when adapters change or virtualization is re-enabled; ignore detached generation callbacks.

Reset renderer-owned engine documents on text or iterator replacement using the existing initialization protocol and options. Caller-initialized managed workers keep their engine document when the renderer restarts.

Claim actual async iterator identities once per mounted component, including across restart and renderer/readiness changes. Restart cancels the current generation rather than re-entering a single-use iterator; fresh iterators remain supported. Removing an open stream releases only its iterator-owned activity and preserves independent imperative activity.
