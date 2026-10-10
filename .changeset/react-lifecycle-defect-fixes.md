---
"@stream-mdx/react": patch
---

Fix React renderer and worker lifecycle defects: terminate factory-created workers on unmount, ensure blockRenderer override resets cleanly when the prop is removed, clear the patch scheduler upon worker detachment to prevent post-detach commits, listen for Worker error events to transition stream status and notify onError, and export HtmlOptions and SyntaxRuleSpec types.
