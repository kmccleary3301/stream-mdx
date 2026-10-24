---
"@stream-mdx/react": major
"stream-mdx": major
---

Remove the fragmented renderer override props in favor of `components: NodePresentations`:

- `inlineComponents` → `components["inline:<kind>"]` (for example `inline:link`, `inline:strong`).
- `htmlElements` → `components["html:<tag>"]`, applied after HTML admission and sanitization.
- `tableElements` → `components.table` and the table part keys.
- `codeRenderers` → `components.code`; route by `metadata.language` and return the prepared `children` for other languages.
- `mathRenderer` → `components["inline:math"]` / `components.math` for presentation.
- `mdxComponents` → `contentComponents` for restricted source components, and the explicit trusted MDX engine provider for trusted MDX.

`ComponentRegistry` now takes a single options object.
