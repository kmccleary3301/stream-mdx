---
"@stream-mdx/core": minor
"@stream-mdx/worker": minor
"@stream-mdx/react": minor
"@stream-mdx/protocol": minor
"@stream-mdx/tui": minor
"@stream-mdx/unified": minor
"stream-mdx": minor
---

Use source-owned records for root code fences and tables, with bounded line and row updates and on-demand full-source reads. Patch consumers must migrate from `appendLines` to `appendCode` and handle the native table operations; the retired operation has no compatibility alias.

Preserve owner identity and retirement guards when replacing active snapshots. Reject regressing revisions and source frontiers, while allowing valid table reference and footnote updates after finalization. Keep final code highlighting and fallback presentation intact without retransmitting source in presentation-only patches.

Queue imperative append and finalize calls behind their matching initialization acknowledgement. Ignore errors from detached or superseded initializations without changing public worker attachment readiness, and keep detached snapshot callbacks callable.
