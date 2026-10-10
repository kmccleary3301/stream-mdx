---
"@stream-mdx/core": minor
"@stream-mdx/worker": minor
"@stream-mdx/react": minor
---

Code fences keep the authored info word as their language. ```` ```js ```` now renders `language-js` / `data-language="js"` (CommonMark), and `meta.lang`, `CodeFenceRendererProps.language` and `parseCodeFenceInfo().lang` report `"js"` instead of the alias target `"javascript"`. Aliases (`js`, `ts`, `py`, `sh`, ...) still select the same Shiki grammar through `normalizeLang`, so highlighting is unchanged. `codeRenderers` lookups fall back to the canonical name, so a renderer registered as `javascript` still receives ```` ```js ```` fences.
