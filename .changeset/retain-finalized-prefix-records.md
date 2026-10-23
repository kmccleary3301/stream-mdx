---
"@stream-mdx/core": patch
"@stream-mdx/plugins": patch
"@stream-mdx/react": patch
"@stream-mdx/worker": patch
---

Reuse completed root block records during native tail parsing and clone only unfinished or affected container snapshots at EOF. Custom document plugins retain isolated previous snapshots. This reduces snapshot copying while preserving authored content and semantic lifecycle ordering.

Keep generic roots and native code, table, and paragraph owners in source order when emitting absolute root child indexes. A later generic heading no longer precedes an earlier native paragraph or displaces retained footnote/HTML roots.

Admit newly reached native code fences even when earlier code owners already exist. Seek admission from the changed root suffix and skip existing source starts before allocating owners. Mixed CR/LF input invalidates the adjacent unfinished parse fragment, while derived indented-code text uses normalized newlines without changing authored raw source.

Reopened native lists and blockquotes publish a bounded semantic finality transition. EOF emits the matching finalize operation for reparsed native suffix roots even when earlier completed records are retained. Core snapshots and the React store keep this finality in canonical block state rather than presentation props. During EOF finalization, retained-prefix indices are operation-local and are reused only after source-boundary validation against the current array; stale indices fall back to binary search.

Keep semantic and enrichment `setProps` deliveries separate when merging or batching. Discarding late code enrichment no longer discards an adjacent canonical container-finality transition.

Reject semantic output from an older parse epoch even when its stream sequence is higher. Direct document-plugin registry registration receives the same previous-snapshot isolation as constructor-installed plugins, including finalized prefix blocks reused by the generic append path.
