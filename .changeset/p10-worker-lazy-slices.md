---
"@stream-mdx/worker": patch
---

Process lazy tokenization in cooperative slices, letting visible ranges preempt background prefetch without losing or repeating tokenized lines.
