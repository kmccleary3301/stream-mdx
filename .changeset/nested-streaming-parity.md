---
"@stream-mdx/core": patch
"@stream-mdx/worker": patch
"@stream-mdx/react": patch
---

Unescape `\|` in table cells on every table path, including streamed root and nested tables.

Stream the body rows of a table nested in a quote or list item from the container's own parse, and seal an unterminated last row at finalize instead of dropping it. A container window keeps the separating lines before a nested table's context lines.

A container replacement in the renderer store keeps the table and paragraph owners it carries forward, so a quote holding a table and a following block no longer loses its content when it finalizes.

Retract a provisional empty list item once its line completes as a thematic break.
