---
"@stream-mdx/core": minor
---

Add `InlineParser.parseSettledPrefix` for native-tokenizer-owned inline preparation. Keep unresolved link, delimiter, code, HTML and declared-extension tails mutable. Return only settled-prefix reference dependencies, and retain the whole tail for unsupported custom parser context.
