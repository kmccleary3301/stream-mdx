---
"@stream-mdx/react": minor
---

Add `mathOptions={{ macroScope: "document" }}`, an explicit KaTeX macro scope owned by one document generation. Complete expressions apply `\gdef` definitions in document order, provisional expressions commit nothing, and replacing or restarting the document clears the scope. Expressions stay isolated by default. KaTeX now always renders with `trust: false`, `maxExpand: 1000` and non-throwing error output.
