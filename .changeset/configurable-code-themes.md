---
"@stream-mdx/core": minor
"@stream-mdx/worker": minor
"@stream-mdx/react": minor
---

Make code themes configurable end-to-end:
- Core: add optional `{ light, dark }` theme pair to the WorkerIn INIT protocol and code highlighting configuration, with default code wrapper attribute support for configured themes.
- Worker: validate themes against Shiki bundledThemes, load themes on demand into the shared singleton highlighter, isolate caches by theme to prevent cross-contamination, use configured themes across all highlight strategies (static, incremental, lazy, diff), and report unknown themes via the INIT error pipeline while falling back to default themes. Direct compilation accepts themes in init options.
- React: expose `themes` on StreamingMarkdown and RendererConfig, forwarding themes to the INIT message, re-initializing the engine when themes change, and applying theme classes in the client store and code view wrappers.
