---
"@stream-mdx/worker": patch
---

Publish the paragraph that follows a table closed by a blank line inside a quote or list item while it streams. The container's parse window now keeps the closing blank line after the table's header, so the paragraph no longer reads as another table row or takes the table's place.
