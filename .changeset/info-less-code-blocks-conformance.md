---
"@stream-mdx/core": patch
"@stream-mdx/worker": patch
"@stream-mdx/react": patch
---

Omit `language-*` and `data-language` attributes on `<code>` and `pre` for info-less code blocks and indented code blocks in accordance with CommonMark specification §4.4/§4.5, reserving `language-*` classes exclusively for code blocks with explicit info strings. Syntax highlighting fallback to plain text continues to operate internally.
