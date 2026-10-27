# @stream-mdx/plugins

## 1.1.0

### Minor Changes

- e599a74: Add bounded heading, list, task-marker, callout, and source-range presentation metadata; expose block-extension views and GitHub-alert callouts; and add scoped, class-configurable streaming text animation.

### Patch Changes

- Updated dependencies [0a2363b]
- Updated dependencies [49b9c1f]
- Updated dependencies [2772411]
- Updated dependencies [576682f]
- Updated dependencies [737f520]
- Updated dependencies [a898f97]
- Updated dependencies [e599a74]
- Updated dependencies [c50ccb3]
  - @stream-mdx/core@1.1.0

## 1.0.0

### Major Changes

- 159a237: Use source-owned records for root code fences, tables, and paragraphs, with bounded line, row, and span updates and on-demand full-source reads. Patch consumers must accept wire protocol 2.0, replace `appendLines` with `appendCode`, adopt `appendParagraph` and `updateParagraphSpans`, and handle native table operations; the retired operation has no compatibility alias. Plugins must use the source snapshot and on-demand `readBlocks` document context instead of a retained `blocks` array.

  Live consumers now initialize one canonical root input document from the
  `INITIALIZED` snapshot baseline and retain later admitted bytes with ordered
  semantic `appendInputSource` root patches. Missing live baselines are
  incompatible; cold `Block[]` and standalone snapshots keep only their honest
  per-block source slices. Native code, table, and paragraph windows share the
  consumer input document while retaining independent owner generations and
  exact newly owned `sourceAppend` suffixes. Empty baselines are valid, and static
  artifact version 1 is unchanged.

  Preserve owner identity and retirement guards when replacing active snapshots. Reject regressing revisions and source frontiers, while allowing valid source-stable table and paragraph dependency meaning updates after finalization. Same-generation finalized source cannot grow or reopen. Keep final code highlighting and fallback presentation intact without retransmitting source in presentation-only patches.

  For paragraph owners after raw Markdown EOF, reopen only the actual trailing paragraph under a fresh owner generation. Do not fuse intervening definition or root source into an earlier paragraph. Keep genuinely unowned provisional following roots eligible for continuation.

  Do not re-finalize completed paragraph owners when later roots extend the shared input. Preserve their original parser frontier and captured source while still publishing valid late dependency changes.

  Queue imperative append and finalize calls behind their matching initialization acknowledgement. Ignore errors from detached or superseded initializations without changing public worker attachment readiness, and keep detached snapshot callbacks callable.

  Render managed paragraph children through the native span view while preserving registered source props and finalized block overrides. Default appends avoid global block/MDX scans; legacy full-source custom props use an explicit cold projection. Cold Block exports also retain admitted open native tables.

  Blocks whose rendering depends on HTML stay on the base HTML grouping path. Genuine inline-HTML paragraphs and HTML-bearing containers retire native owners instead of adopting or rehoming them; tail-local auto-close and native ownership for non-HTML blocks remain.

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

- de107fe: Replace per-block MDX compilation and status messages with native source blocks and an explicit whole-document trusted lane. Restricted source components must be registered through `defineContentComponent`; only serializable descriptors cross the worker boundary, while validators, components, and native children remain host-side. Remove the retired MDX compile-mode and hydration props and default artifact execution. Full MDX now requires `createTrustedMdxEngine`, an explicit host import map, trusted content, and CSP permission for `unsafe-eval`. Worker `FINALIZED` reports native semantic completion, not trusted preparation or render readiness.

  Preserve literal quoted attribute text, including trailing backslashes, while retaining strict-JSON escape semantics and native HTML entity decoding. Freeze admitted JSON recursively after worker transport and freeze the host React props envelope in production. Generate client and server declarations with one output owner so the explicit trusted server entry remains importable.

  Keep trusted flow and fragment children on their native heading, paragraph, code and table owners. Classify module declarations by exact compiler source ranges so successful imports/exports do not leak into Markdown output. Preserve strict native child ownership and independent document leases; source-span parsing remains outside the trusted compiler/evaluator graph.

  Admit nested restricted components through native paragraphs, headings, quotes, lists and sanitized HTML. Preserve emphasis and links around component leaves; keep code, destinations, titles, image alt text, comments and HTML attributes inert. Use opaque native leaves rather than decoded text markers, and remove private marker data before retaining inline metadata.

  Separate validated registered opening headers from the following native Markdown body, including multiline headers whose closing delimiter resembles a blockquote marker. Preserve same-line suffixes and native child source ranges without changing ordinary CommonMark HTML, protected code/comments or invalid-header admission.

  Keep list formatting, configured HTML attributes, parent-sensitive element filters and disabled autolinks intact around registered components. Number only the active prepared ownership tree, including props-owned list segments, so finalized footnote occurrences and their backlinks agree. Carry the producer's existing block epoch in initialization metadata so valid updates to later roots are not rejected as stale.

  Associate nested whole-flow JSX with its explicit trusted inline owner when the native paragraph and compiler region cover the same authored span. Preserve native wrapper children without duplicate rendering or invalid paragraph wrappers. Bundle the source-span parser's ESM-only dependencies in the advertised CommonJS compiler entry instead of passing module namespaces to unified as plugins.

  Match the compiler's standalone JSX/expression paragraph promotion in parse-only ownership scans. Distinguish native inline children from Markdown block children in `TrustedMdxFlowChildSpan`, preserve their exact whitespace and rich inline preparation, and render them without synthetic paragraph wrappers. Exact JSX frames own their descendant regions rather than treating those regions as additional roots. Advance the trusted compiler identity to `native-flow-children-v5` so earlier child metadata is not reused.

  Preserve one canonical prepared ownership tree, including empty trees. When document-wide footnote definitions split compiler inline spans differently from a local native parse, render an exact contiguous run through its single prepared native paragraph and typed continuation slots. Keep strict range/duplicate checks, native reference numbering and backlinks, without per-token owners or whole-document Worker reparsing.

  Trusted replacements retain a detached native store captured once after a successful complete-module host commit. During a pending or failed replacement it remains labelled with its original source generation and document revision, keeps commit-time decorations, and sends no code jobs to the replacement worker. Reset, engine/cache invalidation or disposal, lease or policy changes, or a later successful commit release it. A retained React render error shows the captured source but does not roll back arbitrary trusted host effects.

  Under the explicit `trusted-mdx` content policy, seal APPEND admission at the FINALIZE request while draining input already accepted before the barrier; reject later host or worker appends without source or native-frame mutation until reset or replacement. The `markdown` and `restricted` policies retain their existing append-after-FINALIZE behavior. After restart, automatically owned workers accept imperative APPEND and FINALIZE requests into the fresh-generation FIFO before readiness; after INIT has been posted to the matching fresh worker, they replay in order. A later restart discards requests pending for the earlier generation, and a queued trusted FINALIZE seals admission against later queued appends.

  Prepare packages before rebuilding the hosted worker for doc snapshots and screenshots, so package cleanup cannot remove the selected worker before compilation.

  Prepare canonical trusted children after native owner grouping and before the single ordered document-plugin pass. Preserve exact direct-child source boundaries and reuse completed trees across later footnote definitions, with numbered links, backlinks and reset isolation. Update the MDX transition regression baseline to its native paragraph, list, table and quote views instead of retired per-block compiler wrappers.

  Treat a nested MDX block and its own generated inline owner as one claim only when both match the exact compiler-authored region. Preserve repeated identical JSX siblings by source identity; unrelated duplicate and crossing owners still fail closed.

  Keep the default code-view frame as a `<div>` around the original highlighted `<pre>`, preserving Shiki themes and code metadata without nested `<pre>` markup. Keep the Preview/code seam on the native outer code frame, with preserved inner padding and no duplicated inset border. Reject complete trusted-MDX HTML baseline updates that still contain render diagnostics.

  Honor an explicit `mdx: false` feature setting for restricted registered JSX descriptors at root and nested native container boundaries, without changing ordinary HTML policy.

  When an APPEND ends inside a tag name, attribute, or closing token, keep that fragment out of HTML ownership balancing until a complete token arrives. Treat backslashes inside quoted HTML attributes as literal characters, not quote escapes. Preserve canonical native paragraph, list, table, and quote owners inside completed trusted-MDX flow roots without duplicate ownership.

- 3f24715: Preserve footnote numbering and occurrence metadata when unchanged HTML-bearing paragraph artifacts are rebuilt during streaming. Refresh only those artifacts from valid cached annotations instead of rebuilding every native paragraph target.

  Release generation-owned document-plugin proof state on engine disposal so a retained disposed engine does not retain its former source snapshot.

  Keep the consumer-visible inline projection of HTML-bearing blockquotes current when the no-footnote fast path skips numbering. Native container patches remain child-owned.

  Forward bounded native span changes through cached no-reference finalization so obsolete provisional inline nodes are released.

- 3f24715: Reuse completed root block records during native tail parsing and clone only unfinished or affected container snapshots at EOF. Custom document plugins retain isolated previous snapshots. This reduces snapshot copying while preserving authored content and semantic lifecycle ordering.

  Keep generic roots and native code, table, and paragraph owners in source order when emitting absolute root child indexes. A later generic heading no longer precedes an earlier native paragraph or displaces retained footnote/HTML roots.

  Admit newly reached native code fences even when earlier code owners already exist. Seek admission from the changed root suffix and skip existing source starts before allocating owners. Mixed CR/LF input invalidates the adjacent unfinished parse fragment, while derived indented-code text uses normalized newlines without changing authored raw source.

  Reopened native lists and blockquotes publish a bounded semantic finality transition. EOF emits the matching finalize operation for reparsed native suffix roots even when earlier completed records are retained. Core snapshots and the React store keep this finality in canonical block state rather than presentation props. During EOF finalization, retained-prefix indices are operation-local and are reused only after source-boundary validation against the current array; stale indices fall back to binary search.

  Keep semantic and enrichment `setProps` deliveries separate when merging or batching. Discarding late code enrichment no longer discards an adjacent canonical container-finality transition.

  Reject semantic output from an older parse epoch even when its stream sequence is higher. Direct document-plugin registry registration receives the same previous-snapshot isolation as constructor-installed plugins, including finalized prefix blocks reused by the generic append path.

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
