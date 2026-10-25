---
"@stream-mdx/worker": patch
---

Viewer `TOKENIZE_RANGE` demands no longer re-tokenize code lines that another queued highlighting pass already decorated exactly at the current source and configuration revisions, so a late demand emits no redundant `decorateCode` patch.
