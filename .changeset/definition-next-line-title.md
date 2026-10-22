---
"@stream-mdx/worker": patch
---

Apply a link reference definition title that streams in on the next line. A definition without a title stays open until the following line arrives, so `[label]: /url` followed by `  "Title"` gives the referencing link its title instead of starting a new paragraph.
