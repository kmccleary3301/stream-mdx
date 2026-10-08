---
"@stream-mdx/mermaid": minor
---

Add `createMermaidBlock` factory supporting custom Mermaid configuration, custom error components with retry, default view settings, and debounce options. Serialize Mermaid rendering through a module queue so concurrent blocks with different configurations do not interleave, and preserve `securityLevel: 'strict'` by default.
