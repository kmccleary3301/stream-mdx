---
"@stream-mdx/react": patch
"@stream-mdx/worker": patch
---

- Omit rejected Markdown link URLs, including HTML-owned paragraphs and custom link components.
- Apply paragraph element filters and `unwrapDisallowed` to HTML-normalized paragraphs.
- Bound dense streaming animation delays by `maxBacklogMs` without dropping or reordering text.
- Preserve themes, syntax rules, and HTML policy in fresh and cached Node snapshot initialization metadata.
- Keep paragraphs and lists outside unfinished HTML containers at native block boundaries while preserving balanced HTML and MDX region ownership.
- Forward registered uppercase-initial MDX component names through caller-owned demo worker initialization, retaining them across MDX toggles and restarts.
