---
"@stream-mdx/react": patch
---

Render default KaTeX math from inert authored source during SSR and the initial client render, then prepare KaTeX after commit. Keep prepared output and errors tied to the TeX and display mode that produced them.
