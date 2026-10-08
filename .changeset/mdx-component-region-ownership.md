---
"@stream-mdx/worker": patch
---

Keep a balanced JSX/MDX component that spans blank lines as one owning root. Native CommonMark HTML block type 7 ends at the blank line, so `<Component>` … `</Component>` used to arrive as separate opening, paragraph, and closing blocks whenever MDX was enabled; the opening block compiled alone and reported a missing closing tag next to a duplicate paragraph and leaked end tag. Region grouping now runs before MDX detection for html blocks that leave a container open, and the owning root compiles the complete component with worker-mode MDX (entities decoded, math rendered). A still-unclosed component stays a pending html root and is not compiled until it closes or the document finalizes. `mdx: false` and ordinary lowercase raw HTML keep their existing ownership behavior.
