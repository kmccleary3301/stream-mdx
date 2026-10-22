---
"@stream-mdx/worker": patch
---

Resolve the root tail restart point from the latest paragraph only. Each append and FINALIZE previously re-read up to 4 KB of source for every completed paragraph.
