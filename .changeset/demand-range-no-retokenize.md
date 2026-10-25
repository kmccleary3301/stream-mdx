---
"@stream-mdx/worker": patch
"@stream-mdx/react": patch
---

Viewer `TOKENIZE_RANGE` demands no longer re-tokenize code lines that another queued highlighting pass already decorated exactly at the current source and configuration revisions. A late demand emits no redundant `decorateCode` patch, but it still publishes the block's real `lazyTokenizedUntil` progress. The renderer store now exposes a progress-only `lazyTokenizedUntil` update on managed code blocks immediately, instead of waiting for the next decoration.
