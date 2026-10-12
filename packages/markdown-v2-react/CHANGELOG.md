# @stream-mdx/react

## 1.0.0

### Major Changes

- Release the coordinated 1.0.0 package line. Upgrade all installed StreamMDX packages together and recopy the hosted worker from the matching version. Internal runtime dependencies remain exact versions; the optional unified adapter's StreamMDX peers require the 1.x line.

  Migration from 0.5.0:

  - Remove imports of `@stream-mdx/plugins/registry`, `/base`, and `/math`, their `stream-mdx/plugins/*` convenience re-exports, and `@stream-mdx/worker/streaming/custom-matcher`. `PluginRegistry`, `globalPluginRegistry`, legacy match handlers, and legacy math plugin factories are no longer public. Use native Lezer extensions, serializable `SyntaxRuleSpec` rules, and per-engine `DocumentPluginRegistry` document plugins. Native extension functions belong in the engine or custom worker bundle, not in structured-clone `INIT` messages.
  - `MarkdownEngine` owns its parser, queue, document state, plugins, and caches. Construct it with `{ post, extensions? }`, send configuration and document resets through `handle({ type: "INIT", ... })`, and call terminal `dispose()` when finished. Use public `serveMarkdownWorker` and `createInlineEngineWorker` factories instead of old global runtime plumbing. Worker URLs and actual Worker factories create renderer-owned workers that terminate on detach; an existing Worker is caller-owned. Caller-created inline adapters also need caller-owned termination. See `docs/PUBLIC_API.md` and `docs/PLUGIN_ABI.md` for supported wiring.
    `managedWorker={true}` requires a supplied Worker instance or caller-accessible factory and caller-owned initialization/document commands. URL/default workers and `engine="main-thread"` are rejected, even with a supplied worker source. Managed auto cannot silently fall back inline. Borrowed instances remain caller-owned; factory-created workers remain component-owned and terminate on detach.
  - Provisional lookahead inputs over 512 characters now return raw text before completeness scanning, including closed strings. Oversized finalized/nonprovisional complete content is preserved; within-budget finalized projection retains its behavior. Internal defaults are `maxScanChars: 512`, `maxNewlines: 2`, `maxSyntheticOps: 6`, `maxNestingDepth: 8`, `maxValidationFailures: 1`, and `maxProviderMs: 5`. Provider timers start before scanning; these caps are not React props or latency guarantees.
  - Core root exports no longer expose Lezer converter, math extension factory, link-label normalization, entity decoder, or default/regex plugin adapter internals. Use retained parser/preparation APIs and public worker/compiler entries. Owning parser settings remain authoritative, including disabled math in nested snapshot fallbacks.
  - `ComponentRegistry` treats a block component as custom only when it differs from the built-in default. Custom paragraph and quote wrappers must render the supplied `children` projection to retain native inline, HTML, and nested-block ownership. Do not reconstruct those children from raw source.
  - `CodeFenceRendererProps.renderCode` is a React node, not a callback. Return it directly as a fallback. `language`, fence metadata, and emitted `language-*` classes preserve the authored info word, such as `js`, rather than the canonical Shiki grammar name. Renderer lookups still fall back to canonical names and accept aliases. Unlabeled and indented code has no language class or `data-language` attribute.
  - `restart()` cancels the current async iterator generation; it does not replay a consumed iterator. Supply a fresh iterator for a new stream. Renderer-owned text replacements reset the engine document, while caller-initialized managed workers retain their document ownership.
  - URL transformation and HTML/style sanitization now apply across native client rendering, SSR, and the optional unified adapter. Rejected URLs are omitted; custom components must honor the supplied sanitized attributes and children. `allowedElements` and `disallowedElements` are mutually exclusive.

  The remaining consumed changesets describe the new opt-in renderers, controls, animation, table virtualization, themes, native extension APIs, and correctness/security fixes. These features do not enable themselves when upgrading. See the root README migration section and the generated package changelogs before upgrading custom integrations.

### Minor Changes

- 1669abb: Code fences keep the authored info word as their language. ` ```js ` now renders `language-js` / `data-language="js"` (CommonMark), and `meta.lang`, `CodeFenceRendererProps.language` and `parseCodeFenceInfo().lang` report `"js"` instead of the alias target `"javascript"`. Aliases (`js`, `ts`, `py`, `sh`, ...) still select the same Shiki grammar through `normalizeLang`, so highlighting is unchanged. `codeRenderers` lookups fall back to the canonical name, so a renderer registered as `javascript` still receives ` ```js ` fences.
- 0e96940: Make code themes configurable end-to-end:
  - Core: add optional `{ light, dark }` theme pair to the WorkerIn INIT protocol and code highlighting configuration, with default code wrapper attribute support for configured themes.
  - Worker: validate themes against Shiki bundledThemes, load themes on demand into the shared singleton highlighter, isolate caches by theme to prevent cross-contamination, use configured themes across all highlight strategies (static, incremental, lazy, diff), and report unknown themes via the INIT error pipeline while falling back to default themes. Direct compilation accepts themes in init options.
  - React: expose `themes` on StreamingMarkdown and RendererConfig, forwarding themes to the INIT message, re-initializing the engine when themes change, and applying theme classes in the client store and code view wrappers.
- 4ed0ed3: Add element filtering, code renderer aliases, and autolink protocol disabling:
  - `allowedElements` and `disallowedElements` to filter HTML tag names at render time across markdown and raw HTML (mutually exclusive; supplying both throws).
  - `allowElement` callback predicate `(element, context) => boolean` receiving `{ tagName, properties, blockType? }` and `{ source: "markdown" | "html", parentTagName? }`.
  - `unwrapDisallowed` boolean to unwrap and render children of disallowed elements in place instead of dropping the subtree.
  - Unified element decision function in `ComponentRegistry` applied across client node views, SSR, and raw HTML rendering.
  - `codeRenderers` entries accept `aliases?: string[]` (`{ component, aliases: ["js", "mjs"] }`); languages and aliases resolve case-insensitively.
  - `disableAutolinkProtocols` to render autolink literals and angle autolinks with specific protocols (e.g. `["mailto"]`) as plain text while preserving explicit markdown links.
- 7879ed5: Add isolated MarkdownEngine instances, the public worker/engine entry, custom bundled worker serving, and a main-thread Worker adapter. React supports explicit worker, main-thread, and auto execution modes with a dynamically imported creation-time fallback. Updating onError no longer restarts streamed content.

  Add serializable inline syntax rules with capture attributes, recursively parsed content, lookahead, streaming anticipation, and invalid-INIT recovery. Native worker entries accept Lezer markdown/inline extensions and instance document plugins. HTML supports per-tag attribute lists, mapped components, and opt-in markdown children while retaining literal raw-block defaults and respecting disabled math. Preserve whitespace beyond the required four columns on internal indented-code blank lines, including nested containers. Include invisible reference definitions when determining loose lists. Recognize bare FTP links with native GFM URL punctuation and parenthesis handling.

  Add code fence renderer registration, React-node code fallbacks, math renderer overrides, structured diff views, and sandboxed HTML artifacts with CSP and host link routing. Mermaid accepts the code fence renderer contract and confines invalid-diagram output to its block.

  Add the optional unified adapter for finalized-block remark/rehype transforms, explicit block routing, container replacement, synchronous SSR, asynchronous native fallback, error callbacks, and bounded per-renderer caches. Restore finalized heading levels from engine metadata before running remark and rehype plugins, preserving multiline Setext content and soft breaks. Cover compiler output and real inline-transport updates through the store-backed DOM renderer, including provisional rendering and terminal finalization. Document public exports and replace obsolete plugin factory examples.

  React's minor version change covers public props (engine, codeRenderers, mathRenderer, blockRenderer) and renderer extension modes. Table virtualization is recorded separately in measured-table-rows, and nested block snapshot fixes are recorded in prepared-nested-blocks.

- 38273db: Add opt-in virtualization for large finalized tables in inactive streaming sessions. Preserve natural column widths with measured columns and a full-table sizing pass on viewport resize. Mounted rows use ResizeObserver measurements, stable row IDs, opaque sticky headers, and bounded overscan. Existing overflow-wrapped Table adapters use one managed scroll viewport with scoped style cleanup. Server rendering and active async/imperative sessions retain every row. Updating or removing the tableVirtualization prop updates the mounted view.

  Finalize async iterator tails on normal EOF and track iterator ownership independently of stream prop presence. Refresh table observers and measurements when adapters change or virtualization is re-enabled; ignore detached generation callbacks.

  Reset renderer-owned engine documents on text or iterator replacement using the existing initialization protocol and options. Caller-initialized managed workers keep their engine document when the renderer restarts.

  Claim actual async iterator identities once per mounted component, including across restart and renderer/readiness changes. Restart cancels the current generation rather than re-entering a single-use iterator; fresh iterators remain supported. Removing an open stream releases only its iterator-owned activity and preserves independent imperative activity.

  Initialize owned static text with the complete document rather than repeatedly parsing growing append chunks. Share all existing initialization options, match FIFO acknowledgements, reject pending static renders on worker detach, and leave incremental streams and caller-managed workers unchanged.

  Preserve pending initialization acknowledgement ownership when a borrowed worker outlives its renderer. Detached calls reject without allowing late responses to resolve or repopulate a new attachment.

  Disable showcase table navigation while its source is pending or its virtualized viewport is not ready, so an early click cannot silently target a missing or transient full-table view.

- 032136c: Add `animated` prop to `StreamingMarkdown` and `MarkdownBlocksRenderer` (+ ComponentRegistry) for opt-in streaming text animation.
  - Applies only while blocks are streaming (non-finalized); finalized blocks and static or SSR renders output plain un-animated text.
  - Inline text segments render as stable keyed `<span>` elements (keyed by segment index) preserving DOM node identity across streaming updates.
  - Spans receive class `stream-mdx-anim` and CSS variables `--sm-anim-duration`, `--sm-anim-easing`, and `--sm-anim-delay`.
  - Per-flush delay staggering tracked per renderer and capped by `maxBacklogMs`.
  - Export `STREAM_MDX_ANIMATION_CSS` keyframes with `@media (prefers-reduced-motion: reduce)` support.
- e2c13e5: Add `controls` prop to `StreamingMarkdown` and `MarkdownBlocksRenderer` (+ RendererConfig/registry) for code block, table, and Mermaid diagram copy and download actions.
  - Code blocks: copy raw authored code text (not highlighted HTML), download snippet with language-derived extension. Works for virtualized code.
  - Tables: copy as TSV or Markdown, download CSV, TSV, or Markdown built from finalized cell text with strict RFC 4180 escaping (quotes, commas, newlines). Disabled during streaming; enabled upon table finalization.
  - Mermaid & code-fence renderers: expose controls flags and `copy()` helper via `CodeFenceRendererProps`; `MermaidBlock` opts in to diagram source copying in its toolbar and code view.
  - Buttons: real `<button type="button">` with `aria-label`, `data-stream-mdx-control`, and styling classnames. SSR-safe with no window access during render.
  - Customization: support full replacement slot via `controlsComponent` prop / registry, and i18n label overrides via `controls.labels`.

### Patch Changes

- 5833985: Sanitize finalized code-row HTML without a DOM. `sanitizeCodeHTML` now reuses the shared DOM-free rehype pipeline (`CODE_ROW_ALLOWED_TAGS`/`CODE_ROW_ALLOWED_ATTRS`) when `window` is unavailable, so Node/SSR prerender (Next static export, snapshot stores, `MarkdownBlocksRenderer`) renders Shiki line markup and theme CSS variables instead of throwing, and malformed/untrusted row markup still loses scripts, event handlers, `javascript:` URLs, and unsafe style declarations. The browser DOM path applies the same allowlist and the same allowlisted-property/ASCII-charset style policy (rejecting CSS backslash escapes, comment-splitting, and function values such as `url(...)`), so browser and Node code-row DOM semantics match.

  `ComponentRegistry.hasCustomBlockComponent` now reports a block type as custom only when the registered component differs from the built-in default. Re-passing the built-in component map (`components={registry.getBlockComponentMap()}`, the docs harness shape) keeps native block views enabled, so nested list children and nested code fences render instead of flattening through the default list component. Mid-stream fallback code lines are joined with newlines, so streamed `pre code` text stays a strict logical prefix of the finalized fence source.

- 9c482bd: Keep long documents streaming at high input rates. On a 1 MB document fed at 20,000 characters per second, the worker previously needed about 127 seconds of parse time for a stream that lasts about 50 seconds, so it fell further behind with every append.

  Worker:

  - Checks HTML ownership markers only inside the changed region.
  - Reuses the source slice for each extracted block.
  - Takes change ranges straight from the parser.
  - Caches the tree sanitizer.
  - Skips footnote and link-reference scans for blocks that cannot contain them.

  React renderer:

  - Wakes only the node subscribers whose records changed, not every mounted node.
  - Keeps a code line's props when its text, tokens and HTML are unchanged, so the line is not re-sanitized.
  - When the final canonical snapshot replaces a block, records whose content is unchanged keep their identity, so finalization re-renders only the blocks that changed.

  Theme: the blockquote closing-quote rule now checks `p:is(blockquote *)` before `:last-of-type`. Selected elements and computed styles are unchanged. Chrome no longer restyles every sibling of an appended paragraph, which removed most style-recalculation time on long documents.

- 150a0ac: Omit `language-*` and `data-language` attributes on `<code>` and `pre` for info-less code blocks and indented code blocks in accordance with CommonMark specification §4.4/§4.5, reserving `language-*` classes exclusively for code blocks with explicit info strings. Syntax highlighting fallback to plain text continues to operate internally.
- 73bdb36: Cut main-thread cost while streaming. The renderer store reuses one public block clone per unchanged block instead of re-cloning every block on each read. Structural invariants are scanned when `getInvariantViolations()` is read, not after every patch batch. Browser code-row sanitizing uses a preconfigured DOMPurify instance that applies the style policy during sanitizing, with no second parse. Task-list checkboxes no longer set the redundant `aria-checked` attribute; native checkboxes already expose their checked state.
- fdaa309: Prepare nested list and quote snapshots with the owning engine's parsers, plugin callbacks, and references. Preserve source order and streaming finalization, and serialize normal nested code highlights and code-line children for core and React consumers. Correct tab headings, empty list item continuation, fence info decoding, and disabled table parsing.

  Keep nested lazy tokenization isolated across document replacements and preserve equivalent code through owner reparses. Use compact public token styles, and give every defined footnote occurrence a distinct reference target and footer backlink while rendering missing references literally.

  Honor explicit null code-line HTML in React lazy highlight patches, so token-only descendant enrichment clears stale fallback HTML instead of hiding token colors. Keep existing HTML when patches omit it, retain both-mode highlights, and preserve unchanged row props.

  Keep native HTML paragraph ownership separate from block MDX compilation. Preserve surrounding prose and literal disallowed component tags, retain pending inline JSX projections at finalization, and compile standalone self-closing components through the existing module evaluator rather than the prose renderer.

  Project mixed paragraph content through registered paragraph wrappers and prepared quote children through registered quote wrappers. Preserve the existing `children` extension contract, registry inline/URL/filter context, and coordinator-mode standalone MDX pending-segment metadata while keeping complete components on the module-evaluation path.

  Carry sanitized mixed HTML ownership into native segment snapshots so registered URL transforms and descendant element filters apply after streaming and serialization. Keep registered quote wrappers for provisional and empty quotes as well as finalized content.

- 95be0bf: Fix React renderer and worker lifecycle defects: terminate factory-created workers on unmount, ensure blockRenderer override resets cleanly when the prop is removed, clear the patch scheduler upon worker detachment to prevent post-detach commits, listen for Worker error events to transition stream status and notify onError, and export HtmlOptions and SyntaxRuleSpec types.
- - Omit rejected Markdown link URLs, including HTML-owned paragraphs and custom link components.
  - Apply paragraph element filters and `unwrapDisallowed` to HTML-normalized paragraphs.
  - Bound dense streaming animation delays by `maxBacklogMs` without dropping or reordering text.
  - Preserve themes, syntax rules, and HTML policy in fresh and cached Node snapshot initialization metadata.
  - Keep paragraphs and lists outside unfinished HTML containers at native block boundaries while preserving balanced HTML and MDX region ownership.
  - Forward registered uppercase-initial MDX component names through caller-owned demo worker initialization, retaining them across MDX toggles and restarts.
- e02e7cf: Security hardening: render-time URL transformation across client and SSR, raw HTML attribute and style sanitization, unified HAST URL sanitization, and ArtifactFrame height validation.

  - `@stream-mdx/core`: Replaced dead URL sanitization code with `defaultUrlTransform(url, attribute, context)` which sanitizes URLs for `href` and `src` attributes. Rejects `javascript:`, `vbscript:`, `file:`, and unapproved `data:` URLs (allowing only `data:image/(png|gif|jpeg|webp|avif)` on `src`), while permitting relative paths, fragments, and custom schemes so CommonMark conformance stays at 675/675. In HTML schemas, `on*` event handlers and `srcdoc` attributes are strictly forbidden regardless of user `allowedTags` configuration, and `script` tags are never permitted. Exported `sanitizeStyle` for DOM-free CSS style sanitization.
  - `@stream-mdx/react`: Added `urlTransform` prop to `<StreamingMarkdown />`, `ComponentRegistry`, and `MarkdownBlocksRenderer`. Applied at render time across link and image node views, raw HTML attributes (`href`, `src`, `action`, `formaction`, `xlink:href`), SSR rendering, and `openLink`/`linkSafety` navigation (preventing unsafe scheme execution). Raw HTML `style` attributes now enforce the DOM-free CSS property allowlist (dropping `position`, `url()`, backslash escapes, and expressions while retaining colors and fonts). `ArtifactFrame` strictly verifies `Number.isFinite(data.height)` and clamps between 50 and 10000 px, ignoring `NaN` and `Infinity`.
  - `@stream-mdx/unified`: Added `urlTransform` option to `createUnifiedRenderer` that applies URL sanitization via a final HAST transformation pass after user rehype plugins without stripping user classes.

- Updated dependencies [1669abb]
- Updated dependencies [0e96940]
- Updated dependencies [a73209b]
- Updated dependencies [5833985]
- Updated dependencies [9c482bd]
- Updated dependencies [150a0ac]
- Updated dependencies [7879ed5]
- Updated dependencies [73bdb36]
- Updated dependencies [22fc3c9]
- Updated dependencies [fdaa309]
- Updated dependencies [1842544]
- Updated dependencies
- Updated dependencies [e02e7cf]
- Updated dependencies
- Updated dependencies [c9adde8]
  - @stream-mdx/core@1.0.0
  - @stream-mdx/worker@1.0.0

## 0.5.0

### Minor Changes

- Promote the current hardening and product-surface tranche as `0.5.0`.

  This release rolls up:

  - renderer/store correctness hardening
  - seeded smoke and scheduler-parity release discipline
  - benchmark methodology and comparison cleanup
  - docs, showcase, and TUI/product surface maturation

### Patch Changes

- Updated dependencies
  - @stream-mdx/core@0.5.0
  - @stream-mdx/worker@0.5.0

## 0.1.0

### Minor Changes

- 294e557: Release StreamMDX 0.1.0 across all published packages.

### Patch Changes

- Updated dependencies [294e557]
  - @stream-mdx/core@0.1.0
  - @stream-mdx/worker@0.1.0

## 0.0.3

### Patch Changes

- 47d1374: Add opt-in streaming format anticipation and an optional Mermaid diagram addon for ` ```mermaid ` code blocks.
- 7c79f09: Port the docs demo page to match the ql-homepage streaming UI, and fix several streaming parser/rendering edge cases (hard line breaks and display-math handling) while keeping the hosted worker bundle self-contained for static hosting.
- Updated dependencies [47d1374]
- Updated dependencies [7c79f09]
  - @stream-mdx/core@0.0.3
  - @stream-mdx/worker@0.0.3

## 0.0.2

### Patch Changes

- 9e94660: Docs and release-quality improvements: ship package READMEs/CHANGELOGs, add pack+install smoke tests, expose MDX parity helper entrypoints, and add a deployable docs site workflow.
- Updated dependencies [9e94660]
  - @stream-mdx/core@0.0.2
  - @stream-mdx/worker@0.0.2

## 0.0.1

### Patch Changes

- Release maintenance: CI/build fixes, missing runtime deps (e.g. `rehype-katex`), and improved docs/README wiring for the `stream-mdx` package page.
- Updated dependencies
  - @stream-mdx/core@0.0.1
  - @stream-mdx/worker@0.0.1
