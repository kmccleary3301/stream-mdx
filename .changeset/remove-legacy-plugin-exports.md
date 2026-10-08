---
"@stream-mdx/plugins": minor
"@stream-mdx/worker": minor
"stream-mdx": minor
---

Remove deprecated remnants of the old plugin system in favor of native Lezer extensions and `DocumentPluginRegistry`:
- Remove `@stream-mdx/plugins/registry` (`PluginRegistry`, `globalPluginRegistry`, `RegistryStats`).
- Remove `@stream-mdx/plugins/base` (`BaseIncrementalMatchHandler`, `ConflictResolution`, `PluginError`, `PluginException`, and legacy plugin interfaces).
- Remove `@stream-mdx/plugins/math` (`MathInlinePlugin`, `MathDisplayPlugin`, `MathTokenizer`, and custom streaming math handlers replaced by `@stream-mdx/core` Lezer math extensions).
- Remove convenience re-exports in `stream-mdx` for `stream-mdx/plugins/registry`, `stream-mdx/plugins/base`, and `stream-mdx/plugins/math`.
- Remove legacy export subpath `@stream-mdx/worker/streaming/custom-matcher` from `@stream-mdx/worker`.
