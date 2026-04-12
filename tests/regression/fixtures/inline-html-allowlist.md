# Inline HTML Allowlist

Inline allowlisted HTML should stay bounded and should not swallow nearby text.

Paragraph with <kbd>Ctrl</kbd> + <kbd>K</kbd>, plus <sup>2</sup> and H<sub>2</sub>O.

- List item with inline HTML: <span data-kind="hint">hint text</span> followed by markdown *emphasis*.
- List item with link-shaped HTML: <a href="https://example.com/docs">docs</a> followed by trailing text.

> Blockquote with nested inline HTML: <code>npm run docs:dev</code> and trailing prose.

Final paragraph after inline HTML to make sure open-tag anticipation cannot capture the next block.
