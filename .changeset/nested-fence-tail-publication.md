---
"@stream-mdx/worker": patch
---

Keep content after a closed fenced code block inside a list item visible while it streams, at every chunk size. The bounded container tail now rebuilds from the closing fence line and keeps list-item frames across reparses.
