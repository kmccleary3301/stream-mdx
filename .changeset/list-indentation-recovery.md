---
"@stream-mdx/core": minor
"@stream-mdx/worker": minor
"@stream-mdx/react": minor
---

Add opt-in list-indentation recovery through `StreamingFeatureFlags.listIndentation` and worker `docPlugins.listIndentation`. Same-line over-indented list code that retains leading whitespace is reparsed as paragraph/inline Markdown with original source ranges; fenced code, below-marker indented code, and ordinary same-line code remain unchanged.
