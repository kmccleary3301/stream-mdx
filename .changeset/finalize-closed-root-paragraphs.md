---
"@stream-mdx/worker": patch
---

Settle a root paragraph as finalized when the next root block starts. FINALIZE now finalizes only the open tail, instead of re-settling every completed paragraph and re-parsing from the first block that followed one. In a 64K-unit mixed document, finalize drops from 8.4 s to about 130 ms.
