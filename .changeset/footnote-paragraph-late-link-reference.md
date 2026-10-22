---
"@stream-mdx/worker": patch
---

Resolve a reference link in a paragraph that also carries a footnote reference when the link definition streams in across appends. The footnote numbering bridge now receives the re-resolved spans, so it neither drops the footnote number nor republishes the unresolved link over the resolved one.
