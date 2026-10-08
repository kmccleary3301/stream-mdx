---
"@stream-mdx/react": minor
---

Add `animated` prop to `StreamingMarkdown` and `MarkdownBlocksRenderer` (+ ComponentRegistry) for opt-in streaming text animation.
- Applies only while blocks are streaming (non-finalized); finalized blocks and static or SSR renders output plain un-animated text.
- Inline text segments render as stable keyed `<span>` elements (keyed by segment index) preserving DOM node identity across streaming updates.
- Spans receive class `stream-mdx-anim` and CSS variables `--sm-anim-duration`, `--sm-anim-easing`, and `--sm-anim-delay`.
- Per-flush delay staggering tracked per renderer and capped by `maxBacklogMs`.
- Export `STREAM_MDX_ANIMATION_CSS` keyframes with `@media (prefers-reduced-motion: reduce)` support.
