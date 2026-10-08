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

### 5. Strict Normalization Mode
In addition to standard normalized semantics, a strict comparison mode (`{ strict: true }`) is evaluated identically across all engines:
- Link titles: preserved on `<a>` (`title="..."`)
- Image titles: preserved on `<img>` (`title="..."`)
- Code block language info strings: preserved on `<code>` (`class="language-*"`)

### 6. Evaluated Streamdown Configurations
- **Streamdown (default)**: Chat sanitization and hardening enabled (default rehype plugins: `raw`, `sanitize`, `harden`), `linkSafety: { enabled: false }`.
- **Streamdown (raw HTML)**: Raw HTML enabled with sanitization and hardening disabled via `rehypePlugins: [defaultRehypePlugins.raw]`, `linkSafety: { enabled: false }`.

### 7. micromark 669/675 Conformance Classification
Micromark GFM reference implementation passes 669 of 675 examples. The 6 failures are classified as follows:
1. **GFM Tagfilter vs Pruned Tags (5 failures in HTML blocks: `cm_170`, `cm_171`, `cm_172`, `cm_176`, `cm_178`)**:
   Micromark includes the GFM tagfilter extension (GFM spec §6.11), which filters `<script>`, `<style>`, and `<textarea>` by replacing `<` with `&lt;`. Because these become text nodes in HAST rather than element nodes, the normalizer's `PRUNED_TAGS` does not strip them, whereas the CommonMark spec expected raw HTML block elements that get pruned. This is standard GFM tagfilter behavior, not a normalizer bug.
2. **Dropped FTP Autolink (1 failure in Autolinks (extension): `gfm_628`)**:
   `gfm_628` tests autolinking `ftp://foo.bar.baz`, from pinned `github/cmark-gfm@0.29.0.gfm.13`. The current published GFM specification and modern micromark dropped FTP autolinking support, so micromark leaves the FTP URI as literal text instead of wrapping it in `<a href="...">`.

### 8. Measured Conformance Results

#### Normalized Semantics
| Section | Total | StreamMDX Static | Streaming | SSR | micromark | Streamdown | SD (raw) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TOTAL | 675 | 675 | 675 | 675 | 669 | 540 | 586 |

Streaming divergences from static: 0. Ratchet check (`--check`) validates 675 baseline IDs.

#### Strict Semantics (Link/Image Titles + Code info-strings)
| Section | Total | StreamMDX Static | Streaming | SSR | micromark | Streamdown | SD (raw) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TOTAL | 675 | 599 | 599 | 599 | 669 | 540 | 586 |

Streaming divergences from static: 0.

**StreamMDX Strict Mode Root Cause Analysis**:
All 76 failures in strict mode (599/675) share a single root cause: unlabeled code blocks where StreamMDX's syntax highlighter emits `<code class="language-text">`, whereas the CommonMark specification expects bare `<pre><code>` with no class attribute. Replacing `<pre><code>` with `<pre><code class="language-text">` resolves 76 of 76 strict failures. StreamMDX achieves 100% parity on link titles (90/90), image titles (22/22), and code blocks with explicit info-strings.

## Residual standards boundaries

`packages/markdown-v2-worker/__tests__/residual-standards-boundaries.test.ts` exercises direct compilation through the client store, SSR, and the hosted worker through `FINALIZED`, with chunk sizes 1, 7, and 64. It covers root and nested indented-code whitespace, invisible list definitions, FTP punctuation, balanced parentheses, entities, and native code/heading/list contexts.

The three observed failures at `ac1eae7` were:

| Case | Input as a JSON string | Before | Expected after |
| --- | --- | --- | --- |
| `cm_112` | `"    chunk1\n      \n      chunk2\n"` | Code text `"chunk1\n\n  chunk2"` | Code text `"chunk1\n  \n  chunk2"` |
| `cm_317` | `"- a\n- b\n\n  [ref]: /url\n- d\n"` | `<ul><li>a</li><li>b</li><li>d</li></ul>` | `<ul><li><p>a</p></li><li><p>b</p></li><li><p>d</p></li></ul>` |
| `gfm_628` FTP paragraph | `"Anonymous FTP is available at ftp://foo.bar.baz.\n"` | Literal FTP text | `<p>Anonymous FTP is available at <a href="ftp://foo.bar.baz">ftp://foo.bar.baz</a>.</p>` |

FTP is required by the pinned `0.29.0.gfm.13` example, even though the current published GFM specification and micromark no longer include that FTP example. The native Lezer extension produces the existing `URL` node and follows Lezer's GFM domain and trailing-punctuation rules.

No security policy changed. Existing explicit Markdown destinations and angle autolinks already retain FTP through `inline/lezer-converter.ts` and React's `renderInlineNodes`. The existing DOMPurify `ALLOWED_URI_REGEXP` in `security.ts` explicitly includes FTP via `(?:f|ht)tps?`. The separate exported `sanitizeURL` utility and raw-HTML worker sanitizer have narrower policies; neither is broadened by this change.

The isolated residual-standards gate passed all 675 cases on client static, SSR, and hosted-worker streaming paths, with zero streaming divergences and all 427 baseline IDs retained. Core's 20 test files, React's 38 test files, package builds, and the hosted bundle build passed. The worker suite stopped at the independently owned `worker-footnotes-finalize.test.ts:79` assertion, where the finalized blockquote footnote number was `undefined` instead of `1`; this packet does not change footnote ownership or claim that suite is green.

## Quoted HTML blank-line boundary

The native Lezer HTML block parser checked physical line text for Type 6/7 blank-line termination. A quoted blank line still contains `>`, so an HTML block inside a quote could consume subsequent Markdown as literal text.

Reproduced input:

````markdown
- outer

  > <div>
  >
  > ```js
  > const x=1;
  > ```
  >
  > </div>
````

The observed normalized client output was `<ul><li><p>outer</p><blockquote>```js const x=1; ```</blockquote></li></ul>`. Micromark's expected semantics are `<ul><li><p>outer</p><blockquote><pre><code>const x=1;</code></pre></blockquote></li></ul>`.

The owning parser's block-compatibility extension now uses the native container-relative line position to terminate Type 6/7 HTML. It keeps native quote-marker ranges and source offsets, retains the configured inline parser and plugins, and leaves Type 1 literal HTML continuation unchanged. No HTML helper parser, renderer workaround, sanitizer change, or independent nested parser is added.

Consumer fixtures compare direct/client, SSR, and hosted `FINALIZED` results against micromark for quoted Type 6/7, nested quotes, continuation text, container exit, Type 1 literal control, and root/list-only controls. The core nested snapshot regression checks the resulting native code node, source offset, configured inline plugin, and quote-marker removal.

After the native boundary fix, package and hosted-worker builds passed, the targeted core nested snapshot checks passed, and all 22 consumer fixtures passed compilation/client, SSR, and hosted `FINALIZED` at chunks 1/7/64. The 675-case conformance gate passed all three paths with zero streaming divergences and retained all 427 baseline IDs. The known independently owned footnote suite was not rerun.
