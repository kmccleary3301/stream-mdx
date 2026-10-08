# @stream-mdx/core

## Unreleased

- Convert Lezer HTML tags, comments, and processing instructions to typed inline nodes. Keep parsed markdown children inside allowed inline tags and apply the configured attribute policy.
- Keep HTML containers open across markdown block boundaries using a sanitized ownership tree with prepared markdown children. Add textarea Type 1 continuation through blank lines and strip script/style contents.
- Normalize HTML-containing paragraphs as complete browser-owned regions. Keep configured paragraph components and native inline plugin renderers through private serialized slots, including reconstructed formatting boundaries. Preserve literal pre indentation with matching server and client DOM semantics.
- Complete only the missing closer suffix for identical and different multi-character syntax anticipation markers, without leaking trailing marker text.

## 0.1.0

### Minor Changes

- 294e557: Release StreamMDX 0.1.0 across all published packages.

## 0.0.3

### Patch Changes

- 47d1374: Add opt-in streaming format anticipation and an optional Mermaid diagram addon for ` ```mermaid ` code blocks.
- 7c79f09: Port the docs demo page to match the ql-homepage streaming UI, and fix several streaming parser/rendering edge cases (hard line breaks and display-math handling) while keeping the hosted worker bundle self-contained for static hosting.

## 0.0.2

### Patch Changes

- 9e94660: Docs and release-quality improvements: ship package READMEs/CHANGELOGs, add pack+install smoke tests, expose MDX parity helper entrypoints, and add a deployable docs site workflow.

## 0.0.1

### Patch Changes

- Release maintenance: CI/build fixes, missing runtime deps (e.g. `rehype-katex`), and improved docs/README wiring for the `stream-mdx` package page.
