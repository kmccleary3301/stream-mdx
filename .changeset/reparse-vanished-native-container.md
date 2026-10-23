---
"@stream-mdx/worker": patch
---

Distinguish a vanished bounded-window root from a closed tail: the primary append path reparses canonically, while nested preparation and finalization fail loudly rather than reusing stale state.
