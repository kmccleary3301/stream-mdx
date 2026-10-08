---
"@stream-mdx/react": minor
"@stream-mdx/mermaid": minor
---

Add `controls` prop to `StreamingMarkdown` and `MarkdownBlocksRenderer` (+ RendererConfig/registry) for code block, table, and Mermaid diagram copy and download actions.
- Code blocks: copy raw authored code text (not highlighted HTML), download snippet with language-derived extension. Works for virtualized code.
- Tables: copy as TSV or Markdown, download CSV, TSV, or Markdown built from finalized cell text with strict RFC 4180 escaping (quotes, commas, newlines). Disabled during streaming; enabled upon table finalization.
- Mermaid & code-fence renderers: expose controls flags and `copy()` helper via `CodeFenceRendererProps`; `MermaidBlock` opts in to diagram source copying in its toolbar and code view.
- Buttons: real `<button type="button">` with `aria-label`, `data-stream-mdx-control`, and styling classnames. SSR-safe with no window access during render.
- Customization: support full replacement slot via `controlsComponent` prop / registry, and i18n label overrides via `controls.labels`.
