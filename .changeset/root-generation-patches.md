---
"@stream-mdx/core": patch
"@stream-mdx/worker": patch
"@stream-mdx/react": patch
"@stream-mdx/protocol": patch
"@stream-mdx/tui": patch
"stream-mdx": patch
---

Require each live worker PATCH and every schema-2 protocol event to carry its native root document generation. Renderers and TUI event stores reject stale-generation work against the current validated INITIALIZED baseline, including after queueing; TUI replacement also clears old transaction/status metadata. Caller-managed worker attachment stays pending until an observed baseline, then drains accepted input once. Node and direct snapshot compilers bind patch/finalization handling to that baseline. Static snapshot artifacts remain version 1.

Explicit cold TUI replacement retires the old native lease, so delayed snapshots and lifecycle events cannot reclaim the replacement. A validated newer same-stream baseline can resume delivery.

Bind same-turn restart capacity waits to the new session's admitting renderer, retaining their requested capacity and cancellation options without dropping accepted source.

Use the task-packed protocol dependency in installed Node, Next, and Vite smoke consumers instead of allowing a registry fallback.

Generate JavaScript for both installed runtime loaders and replay a replacement root's actual finalization patches before checking completed source.

Render the terminal example from authored cold block source without adding duplicate heading, quote, or code-fence markers.
