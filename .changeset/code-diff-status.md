---
"@stream-mdx/core": minor
"@stream-mdx/worker": minor
---

Report whether a diff document's declared hunk row counts hold. `CodeBlockMetadata.diffStatus` is `"incomplete"` while an open hunk still owes rows, `"malformed"` once the document is finalized with rows still owed or a new hunk or file starts before the previous hunk's rows arrive, and `"complete"` otherwise. Token exactness is reported separately and is unaffected. Ordinary code carries no diff status.
