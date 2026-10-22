---
"@stream-mdx/worker": patch
---

Settle a fenced code block as finalized when its closing fence arrives. FINALIZE no longer re-publishes and re-highlights every completed code block, so its cost no longer grows with the number of fences in the document.
