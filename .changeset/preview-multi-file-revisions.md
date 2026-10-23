---
"@stream-mdx/preview": minor
---

Preview multi-file React/TSX projects with nested relative imports (`.ts/.tsx/.js/.jsx/.json/.css`, index files). Unresolved imports name the importing file and specifier and keep the last valid frame. A revision that changes only CSS restyles the visible frame in place and keeps app state (`styleResult: "styles-updated"`); any other change remounts a fresh frame.
