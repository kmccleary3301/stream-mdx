---
"stream-mdx": patch
"@stream-mdx/plugins": patch
"@stream-mdx/worker": patch
---

Recognize every footnote definition in a run of consecutive `[^label]:` lines. Previously only the first definition in a paragraph registered, so references to the later ones rendered as literal `[^label]` text.
