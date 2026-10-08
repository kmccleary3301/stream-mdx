# Conformance Test Fixtures

## Sources and Versions

1. **CommonMark Spec 0.31.2**
   - Source: `commonmark-spec@0.31.2` (npm package) / `https://spec.commonmark.org/0.31.2/spec.json`
   - Spec URL: https://spec.commonmark.org/0.31.2/
   - Fixture file: `commonmark-spec-0.31.2.json` (652 examples)

2. **GitHub Flavored Markdown (GFM) Spec Extensions**
   - Source: `github/cmark-gfm` release `0.29.0.gfm.13`
   - File URL: `https://raw.githubusercontent.com/github/cmark-gfm/0.29.0.gfm.13/test/spec.txt`
   - Sections extracted:
     - `Tables (extension)` (8 examples)
     - `Task list items (extension)` (2 examples)
     - `Strikethrough (extension)` (2 examples)
     - `Autolinks (extension)` (11 examples)
   - Fixture file: `gfm-spec-extensions.json` (23 examples)

## Semantic Normalization Rules

To provide a fair, renderer-agnostic comparison between reference (Micromark GFM), StreamMDX, and Streamdown 2.7.0, rendered HTML is parsed and converted to a canonical tree of semantic elements only.

### 1. Allowed Semantic Elements & Attributes
Only the following HTML elements are preserved in the semantic tree:
- Headings: `h1`, `h2`, `h3`, `h4`, `h5`, `h6` (attributes stripped)
- Blocks: `p`, `blockquote`, `hr`, `pre` (attributes stripped)
- Lists: `ul`, `li` (attributes stripped)
- Ordered lists: `ol` (only `start` attribute preserved if `start !== "1"`)
- Inlines: `em`, `strong`, `del`, `code`, `br` (attributes stripped)
- Links: `a` (only `href` attribute preserved, URI-normalized)
- Images: `img` (only `src` and `alt` attributes preserved)
- Tables: `table`, `thead`, `tbody`, `tr` (attributes stripped)
- Table cells: `th`, `td` (only `align` attribute preserved; normalized from either `align="..."` or inline CSS `style="text-align: ..."`)
- Checkboxes: `input` (only when `type="checkbox"`; preserved attributes are `type="checkbox"` and `checked` if checked)

### 2. Wrapper Unwrapping
Non-semantic structural containers are unwrapped, hoisting their children in-place:
- `<div>`, `<span>`, `<section>`, `<article>`
- Line containers (e.g. Shiki `<span class="line">` inside `<pre><code>`)
- Code highlighting spans (e.g. `<span style="color: ...">` inside code blocks)

### 3. Chrome Removal
Renderer-specific chrome, decorations, and non-content UI are pruned completely along with their subtrees:
- Buttons: `<button>` (e.g. copy buttons, download buttons)
- Icons / vectors: `<svg>`, `<path>`, `<polygon>`
- Streamdown chrome: elements matching `[data-streamdown="code-block-header"]`, `[data-streamdown="code-block-actions"]`
- Non-content tags: `<script>`, `<style>`, `<meta>`, `<link>`

### 4. Text & Whitespace Normalization
Whitespace normalization follows the official CommonMark test normalization specification (`normalize.py`):
- Outside `<pre>` blocks, consecutive whitespace characters (including newlines and tabs) are collapsed into a single space ` `.
- Whitespace immediately adjacent to block-level boundaries (leading/trailing inside blocks, or between block elements) is stripped.
- HTML entities are decoded to standard Unicode characters (e.g. `&amp;` -> `&`, `&quot;` -> `"`, `&lt;` -> `<`, `&gt;` -> `>`).
- Inside `<pre>` blocks, literal code text and newlines are preserved verbatim.
