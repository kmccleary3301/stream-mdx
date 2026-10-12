# @stream-mdx/plugins

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

- 7879ed5: Add isolated MarkdownEngine instances, the public worker/engine entry, custom bundled worker serving, and a main-thread Worker adapter. React supports explicit worker, main-thread, and auto execution modes with a dynamically imported creation-time fallback. Updating onError no longer restarts streamed content.

  Add serializable inline syntax rules with capture attributes, recursively parsed content, lookahead, streaming anticipation, and invalid-INIT recovery. Native worker entries accept Lezer markdown/inline extensions and instance document plugins. HTML supports per-tag attribute lists, mapped components, and opt-in markdown children while retaining literal raw-block defaults and respecting disabled math. Preserve whitespace beyond the required four columns on internal indented-code blank lines, including nested containers. Include invisible reference definitions when determining loose lists. Recognize bare FTP links with native GFM URL punctuation and parenthesis handling.

  Add code fence renderer registration, React-node code fallbacks, math renderer overrides, structured diff views, and sandboxed HTML artifacts with CSP and host link routing. Mermaid accepts the code fence renderer contract and confines invalid-diagram output to its block.

  Add the optional unified adapter for finalized-block remark/rehype transforms, explicit block routing, container replacement, synchronous SSR, asynchronous native fallback, error callbacks, and bounded per-renderer caches. Restore finalized heading levels from engine metadata before running remark and rehype plugins, preserving multiline Setext content and soft breaks. Cover compiler output and real inline-transport updates through the store-backed DOM renderer, including provisional rendering and terminal finalization. Document public exports and replace obsolete plugin factory examples.

  React's minor version change covers public props (engine, codeRenderers, mathRenderer, blockRenderer) and renderer extension modes. Table virtualization is recorded separately in measured-table-rows, and nested block snapshot fixes are recorded in prepared-nested-blocks.

- 1842544: Remove deprecated remnants of the old plugin system in favor of native Lezer extensions and `DocumentPluginRegistry`:
  - Remove `@stream-mdx/plugins/registry` (`PluginRegistry`, `globalPluginRegistry`, `RegistryStats`).
  - Remove `@stream-mdx/plugins/base` (`BaseIncrementalMatchHandler`, `ConflictResolution`, `PluginError`, `PluginException`, and legacy plugin interfaces).
  - Remove `@stream-mdx/plugins/math` (`MathInlinePlugin`, `MathDisplayPlugin`, `MathTokenizer`, and custom streaming math handlers replaced by `@stream-mdx/core` Lezer math extensions).
  - Remove convenience re-exports in `stream-mdx` for `stream-mdx/plugins/registry`, `stream-mdx/plugins/base`, and `stream-mdx/plugins/math`.
  - Remove legacy export subpath `@stream-mdx/worker/streaming/custom-matcher` from `@stream-mdx/worker`.

### Patch Changes

- a73209b: Recognize every footnote definition in a run of consecutive `[^label]:` lines. Previously only the first definition in a paragraph registered, so references to the later ones rendered as literal `[^label]` text.
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

- fdaa309: Prepare nested list and quote snapshots with the owning engine's parsers, plugin callbacks, and references. Preserve source order and streaming finalization, and serialize normal nested code highlights and code-line children for core and React consumers. Correct tab headings, empty list item continuation, fence info decoding, and disabled table parsing.

  Keep nested lazy tokenization isolated across document replacements and preserve equivalent code through owner reparses. Use compact public token styles, and give every defined footnote occurrence a distinct reference target and footer backlink while rendering missing references literally.

  Honor explicit null code-line HTML in React lazy highlight patches, so token-only descendant enrichment clears stale fallback HTML instead of hiding token colors. Keep existing HTML when patches omit it, retain both-mode highlights, and preserve unchanged row props.

  Keep native HTML paragraph ownership separate from block MDX compilation. Preserve surrounding prose and literal disallowed component tags, retain pending inline JSX projections at finalization, and compile standalone self-closing components through the existing module evaluator rather than the prose renderer.

  Project mixed paragraph content through registered paragraph wrappers and prepared quote children through registered quote wrappers. Preserve the existing `children` extension contract, registry inline/URL/filter context, and coordinator-mode standalone MDX pending-segment metadata while keeping complete components on the module-evaluation path.

  Carry sanitized mixed HTML ownership into native segment snapshots so registered URL transforms and descendant element filters apply after streaming and serialization. Keep registered quote wrappers for provisional and empty quotes as well as finalized content.

- Updated dependencies [1669abb]
- Updated dependencies [0e96940]
- Updated dependencies [5833985]
- Updated dependencies [9c482bd]
- Updated dependencies [150a0ac]
- Updated dependencies [7879ed5]
- Updated dependencies [73bdb36]
- Updated dependencies [fdaa309]
- Updated dependencies [e02e7cf]
- Updated dependencies
  - @stream-mdx/core@1.0.0

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

## 0.1.0

### Minor Changes

- 294e557: Release StreamMDX 0.1.0 across all published packages.

### Patch Changes

- Updated dependencies [294e557]
  - @stream-mdx/core@0.1.0

## 0.0.3

### Patch Changes

- Updated dependencies [47d1374]
- Updated dependencies [7c79f09]
  - @stream-mdx/core@0.0.3

## 0.0.2

### Patch Changes

- 9e94660: Docs and release-quality improvements: ship package READMEs/CHANGELOGs, add pack+install smoke tests, expose MDX parity helper entrypoints, and add a deployable docs site workflow.
- Updated dependencies [9e94660]
  - @stream-mdx/core@0.0.2

## 0.0.1

### Patch Changes

- Release maintenance: CI/build fixes, missing runtime deps (e.g. `rehype-katex`), and improved docs/README wiring for the `stream-mdx` package page.
- Updated dependencies
  - @stream-mdx/core@0.0.1
