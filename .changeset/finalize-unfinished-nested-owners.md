---
"@stream-mdx/worker": patch
---

Track unfinished nested owners and their canonical containers so EOF lifecycle updates do not scan every completed owner. Retire displaced suffix containers while preserving surviving same-ID owner leases.
