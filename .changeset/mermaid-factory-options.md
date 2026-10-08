---
"@stream-mdx/mermaid": minor
---

Add `createMermaidBlock` factory supporting custom Mermaid configuration, custom error components with retry, default view settings, debounce options, and custom Mermaid module instances or loaders. Serialize Mermaid rendering through a module queue so concurrent blocks with different configurations do not interleave, and preserve `securityLevel: 'strict'` by default.
