---
"@stream-mdx/worker": patch
---

Reparse a provisional native block from its line start when its parser offset omits authored indentation. This keeps a split indented-code line in code instead of reclassifying its continuation as a paragraph.
