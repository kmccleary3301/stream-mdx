---
"@stream-mdx/core": major
"@stream-mdx/worker": major
"@stream-mdx/react": major
"@stream-mdx/tui": major
"stream-mdx": major
---

Native list and blockquote streaming preserves current nested children in open dumps and Core cold exports. Nested code, table, and paragraph leaves update through existing owner patch families and generic child operations; authored ranges remain physical UTF-16 coordinates in the canonical input document.

Primary list paragraphs use native paragraph deltas while cold exports preserve the existing item representation. Empty tasks retain their authored markers without rendering duplicate marker text, including after finalization.

Keep provisional inline HTML and allowlisted MDX repair separate from authored source. Rejected HTML stays literal even inside formatted inline content; unclosed previews become literal at finalization without consuming later paragraphs.

Preserve the canonical nested hierarchy during late link and footnote resolution. Publish targeted meaning updates with stable authored ranges and historical values, including generic heading metadata and links. Footnote numbering and occurrence anchors follow document reference order across nested paragraphs and table cells.

Preserve table headers and alignments when CRLF arrives one UTF-16 unit at a time. Parse lone CR as a line ending without changing physical source offsets, invalidate affected incremental fragments when LF follows, and advance retired root paragraph generations across source-kind changes.

Carry canonical generic ranges and metadata through existing property patches. Core and React apply metadata replacement, omission and explicit clearing consistently, without resurrecting stale block metadata or mutating historical exports. Preserve a list item's canonical source extent when retained marker context is shorter than its managed primary paragraph.

Preserve completed paragraph leases when retained native marker context omits their body. Publish current HTML source ranges alongside sanitized content, and keep type-1 HTML, comments and processing instructions outside type-6/7 continuation recovery.

Remove invalidated suffix reference definitions as titles arrive, and retire paragraph ownership when a footnote definition becomes complete. Native list child identity carries its canonical ordinal so ordered markers remain correct across bounded windows.

Native code rows remain in their owned code index rather than a duplicate generic child tree. Native line ranges subscribe only to changed aligned ranges, including late decoration and provisional boundary completion.

Keep completed list-item DOM mounted when list looseness changes; inherited presentation updates through the parent layout context. Current ancestor ordering epochs remain observable without restamping unchanged descendants, while stale updates are still rejected.

Reuse typed container markers and list looseness in bounded native windows without reading completed item gaps. Preserve quote markers inside the changing paragraph and refresh marker-only opening lines before deriving their retained context.
