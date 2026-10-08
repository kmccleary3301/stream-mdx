# Footnotes Plugin Spec (V2 Markdown)

This plugin adds footnote support to the V2 Markdown pipeline while preserving @lezer/markdown edge-case handling. It consists of:

- Inline references: `[^label]` → rendered as a superscript link to the footnote item.
- Definitions: starting a paragraph with `[^label]:` followed by text and optional indented continuations.
- A synthetic final block `footnotes` containing an ordered list of items.

## Rules

- Numbering: first-seen reference order is retained across streaming updates. Defined, rendered footnotes receive dense display numbers in that order; unresolved labels do not create visible numbering holes.
- Definitions:
  - Syntax: `[^label]: text...`
  - Continuation: subsequent indented lines (4 spaces or tab) and blank lines are included.
  - Duplicate labels: first definition wins; subsequent definitions are ignored.
- Scoping:
  - Code and literal HTML contents are ignored. Typed inline nodes in HTML ownership slots participate.
  - Definition paragraphs are retagged to `footnote-def` (rendered as nothing).
- Streaming:
  - The synthetic `footnotes` block is always the last block and updates as content grows.
  - Inline references in a non-finalized tail may render as plain text until the block finalizes (consistent with the tail-only inline parsing policy).

## Rendering

- Inline reference: `<sup class="footnote-ref"><a id="fnref:n" href="#fn:n">n</a></sup>`. The second occurrence uses `fnref:n:2`, then `fnref:n:3`, and so on.
- Footnotes list: `<section class="footnotes"><hr /><ol><li id="fn:n">… <a class="footnote-backref" href="#fnref:n">↩</a> <a class="footnote-backref" href="#fnref:n:2">↩<sup>2</sup></a></li>…</ol></section>`. Every defined occurrence has its own backlink.
- Missing definitions render their references literally as `[^label]`, without an anchor or an empty footer item. References also remain literal while a dirty tail suppresses footer publication.

## Integration Points

- Inline parser adds `footnote-ref` nodes via a regex plugin.
- Document-phase plugin:
  - Collects definitions from paragraph blocks, retagging them as `footnote-def`.
  - The engine retains native `LinkReference` spans beginning with a supported footnote label when the footnotes document plugin is enabled. Single-word definitions reach this phase instead of disappearing as ordinary link-reference definitions.
  - Counts canonical rendered snapshot/HTML paths once in document order. Serialized `props.inline`, `props.block.payload.inline`, container compatibility fields, and HTML marker descriptors mirror those assignments without creating extra occurrences.
  - Appends a synthetic `footnotes` block with items.
  - Uses the `InlineParser` from worker state to parse definition content for better rendering.
  - Numbers every serialized child inline representation and existing HTML ownership inline descriptor, and derives blockquote compatibility inline from those actual children. JSON snapshots, direct/worker PATCH consumers, and finalized roots carry the same numbers.
  - Copies only changed footnote-owned paths. Reused roots and unrelated prepared code/HTML artifacts remain unchanged, so incremental diffs retain their old numbered snapshots.

## Edge Cases

- Reference before definition: its first-seen order is retained; when the definition appears, the item and links are populated. Resolving an earlier reference can renumber later defined footnotes.
- Multiple references to the same label: reuse the same display number, but have distinct occurrence IDs and backlinks.
- Duplicate definitions: first definition wins (later duplicates ignored).
- References in code or literal HTML contents are ignored. References inside a rendered definition body are included, using the owning inline parser.

## Types

- Inline: `{ kind: 'footnote-ref', label: string, number?: number, occurrence?: number, defined?: boolean }`
- Footer item: `FootnoteItem` contains `{ number, label, inlines, refCount? }`; the producer always writes the actual rendered occurrence count, not metadata aliases. An omitted count retains the single-reference default.
- Blocks: `footnote-def` (hidden), `footnotes` (final ordered list)

