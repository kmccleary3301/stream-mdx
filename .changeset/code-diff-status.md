---
"@stream-mdx/core": major
"@stream-mdx/worker": major
"@stream-mdx/react": major
---

Report whether a diff document's declared hunk row counts hold. `CodeBlockMetadata.diffStatus` is `"incomplete"` while an open hunk still owes rows, `"malformed"` once the document is finalized with rows still owed or a new hunk or file starts before the previous hunk's rows arrive, and `"complete"` otherwise. Token exactness is reported separately and is unaffected. Ordinary code carries no diff status.

Native root and nested code blocks report the same `diffStatus` through `CodeNodeHandle.readMetadata()` and the React store's code metadata. One pure owner (`abandonsOwedRows`/`codeDiffStatus`) computes it for standalone, root and nested code.

Migration: `CodeLineDecoration` and `HighlightResult` can report `{ exactness: "unavailable", tokens: null, reason }`, for example when lazy tokenization reaches an unbased diff hunk without the prefix context needed to reconstruct diff-side state. Narrow on `exactness` before reading `tokens`. The default React renderer shows unavailable rows as unhighlighted authored source text while preserving diff markers.
