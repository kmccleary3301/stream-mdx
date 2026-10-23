---
"@stream-mdx/worker": patch
"@stream-mdx/plugins": patch
---

Preserve footnote numbering and occurrence metadata when unchanged HTML-bearing paragraph artifacts are rebuilt during streaming. Refresh only those artifacts from valid cached annotations instead of rebuilding every native paragraph target.

Release generation-owned document-plugin proof state on engine disposal so a retained disposed engine does not retain its former source snapshot.

Keep the consumer-visible inline projection of HTML-bearing blockquotes current when the no-footnote fast path skips numbering. Native container patches remain child-owned.

Forward bounded native span changes through cached no-reference finalization so obsolete provisional inline nodes are released.
