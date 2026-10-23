---
"@stream-mdx/core": minor
"@stream-mdx/worker": minor
"@stream-mdx/react": minor
---

Report whether a diff document's declared hunk row counts hold. `CodeBlockMetadata.diffStatus` is `"incomplete"` while an open hunk still owes rows, `"malformed"` once the document is finalized with rows still owed or a new hunk or file starts before the previous hunk's rows arrive, and `"complete"` otherwise. Token exactness is reported separately and is unaffected. Ordinary code carries no diff status.

Native root and nested code blocks report the same `diffStatus` through `CodeNodeHandle.readMetadata()` and the React store's code metadata. One pure owner (`abandonsOwedRows`/`codeDiffStatus`) computes it for standalone, root and nested code.
