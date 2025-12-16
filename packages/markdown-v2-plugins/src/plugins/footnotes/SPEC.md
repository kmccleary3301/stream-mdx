# Footnotes Plugin Spec (V2 Markdown)

This plugin adds footnote support to the V2 Markdown pipeline while preserving @lezer/markdown edge-case handling. It consists of:

- Inline references: `[^label]` → rendered as a superscript link to the footnote item.
- Definitions: starting a paragraph with `[^label]:` followed by text and optional indented continuations.
- A synthetic final block `footnotes` containing an ordered list of items.

## Rules

- Numbering: assigned in order of first reference appearance (stable across streaming updates).
- Definitions:
  - Syntax: `[^label]: text...`
  - Continuation: subsequent indented lines (4 spaces or tab) and blank lines are included.
  - Duplicate labels: first definition wins; subsequent definitions are ignored.
- Scoping:
  - References inside `code` or `html` blocks are ignored for numbering.
  - Definition paragraphs are retagged to `footnote-def` (rendered as nothing).
- Streaming:
  - The synthetic `footnotes` block is always the last block and updates as content grows.
  - Inline references in a non-finalized tail may render as plain text until the block finalizes (consistent with the tail-only inline parsing policy).

## Rendering

- Inline reference: `<sup class="footnote-ref"><a id="fnref:n" href="#fn:n">n</a></sup>`
- Footnotes list: `<section class="footnotes"><hr /><ol><li id="fn:n">… <a class="footnote-backref" href="#fnref:n">↩</a></li>…</ol></section>`

## Integration Points

- Inline parser adds `footnote-ref` nodes via a regex plugin.
- Document-phase plugin:
  - Collects definitions from paragraph blocks, retagging them as `footnote-def`.
  - Assigns numbers by scanning textual blocks (paragraph, heading, blockquote, list) for `[^label]`.
  - Appends a synthetic `footnotes` block with items.
  - Uses the `InlineParser` from worker state to parse definition content for better rendering.

## Edge Cases

- Reference before definition: number reserved on first occurrence; when the definition appears later, the item content is populated.
- Multiple references to the same label: reuse the same number.
- Duplicate definitions: first definition wins (later duplicates ignored).
- References inside code fences or HTML blocks: ignored for numbering.

## Types

- Inline: `{ kind: 'footnote-ref', label: string, number?: number }`
- Blocks: `footnote-def` (hidden), `footnotes` (final ordered list)

