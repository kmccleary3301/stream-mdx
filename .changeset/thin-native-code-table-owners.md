---
"@stream-mdx/core": major
"@stream-mdx/plugins": major
"@stream-mdx/worker": major
"@stream-mdx/react": major
"@stream-mdx/protocol": major
"@stream-mdx/tui": major
"@stream-mdx/unified": major
"stream-mdx": major
---

Use source-owned records for root code fences, tables, and paragraphs, with bounded line, row, and span updates and on-demand full-source reads. Patch consumers must accept wire protocol 2.0, replace `appendLines` with `appendCode`, adopt `appendParagraph` and `updateParagraphSpans`, and handle native table operations; the retired operation has no compatibility alias. Plugins must use the source snapshot and on-demand `readBlocks` document context instead of a retained `blocks` array.

Live consumers now initialize one canonical root input document from the
`INITIALIZED` snapshot baseline and retain later admitted bytes with ordered
semantic `appendInputSource` root patches. Missing live baselines are
incompatible; cold `Block[]` and standalone snapshots keep only their honest
per-block source slices. Native code, table, and paragraph windows share the
consumer input document while retaining independent owner generations and
exact newly owned `sourceAppend` suffixes. Empty baselines are valid, and static
artifact version 1 is unchanged.

Preserve owner identity and retirement guards when replacing active snapshots. Reject regressing revisions and source frontiers, while allowing valid source-stable table and paragraph dependency meaning updates after finalization. Same-generation finalized source cannot grow or reopen. Keep final code highlighting and fallback presentation intact without retransmitting source in presentation-only patches.

For paragraph owners after raw Markdown EOF, reopen only the actual trailing paragraph under a fresh owner generation. Do not fuse intervening definition or root source into an earlier paragraph. Keep genuinely unowned provisional following roots eligible for continuation.

Do not re-finalize completed paragraph owners when later roots extend the shared input. Preserve their original parser frontier and captured source while still publishing valid late dependency changes.

Queue imperative append and finalize calls behind their matching initialization acknowledgement. Ignore errors from detached or superseded initializations without changing public worker attachment readiness, and keep detached snapshot callbacks callable.

Render managed paragraph children through the native span view while preserving registered source props and finalized block overrides. Default appends avoid global block/MDX scans; legacy full-source custom props use an explicit cold projection. Cold Block exports also retain admitted open native tables.
