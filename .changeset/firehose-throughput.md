---
"stream-mdx": patch
"@stream-mdx/core": patch
"@stream-mdx/plugins": patch
"@stream-mdx/worker": patch
"@stream-mdx/react": patch
"@stream-mdx/theme-tailwind": patch
---

Keep long documents streaming at high input rates. On a 1 MB document fed at 20,000 characters per second, the worker previously needed about 127 seconds of parse time for a stream that lasts about 50 seconds, so it fell further behind with every append.

Worker:

- Checks HTML ownership markers only inside the changed region.
- Reuses the source slice for each extracted block.
- Takes change ranges straight from the parser.
- Caches the tree sanitizer.
- Skips footnote and link-reference scans for blocks that cannot contain them.

React renderer:

- Wakes only the node subscribers whose records changed, not every mounted node.
- Keeps a code line's props when its text, tokens and HTML are unchanged, so the line is not re-sanitized.
- When the final canonical snapshot replaces a block, records whose content is unchanged keep their identity, so finalization re-renders only the blocks that changed.

Theme: the blockquote closing-quote rule now checks `p:is(blockquote *)` before `:last-of-type`. Selected elements and computed styles are unchanged. Chrome no longer restyles every sibling of an appended paragraph, which removed most style-recalculation time on long documents.
