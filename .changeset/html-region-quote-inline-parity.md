---
"@stream-mdx/worker": patch
---

Give a blockquote the same metadata whether its HTML region arrives in one append or several. Previously, a blockquote parsed before its enclosing `<details>`-style region closed kept the root-level compatibility `inline` once the region adopted it, while a single-shot parse left that field empty. Rendered HTML was already identical.
