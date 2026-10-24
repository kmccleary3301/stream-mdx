# @stream-mdx/react

## 1.0.0

### Major Changes

- f28e605: Presentation wrappers receive prepared children, bounded metadata, and source-bound actions; the unbounded full Block prop is removed.
- 2c019b9: Report whether a diff document's declared hunk row counts hold. `CodeBlockMetadata.diffStatus` is `"incomplete"` while an open hunk still owes rows, `"malformed"` once the document is finalized with rows still owed or a new hunk or file starts before the previous hunk's rows arrive, and `"complete"` otherwise. Token exactness is reported separately and is unaffected. Ordinary code carries no diff status.

  Native root and nested code blocks report the same `diffStatus` through `CodeNodeHandle.readMetadata()` and the React store's code metadata. One pure owner (`abandonsOwedRows`/`codeDiffStatus`) computes it for standalone, root and nested code.

  Migration: `CodeLineDecoration` and `HighlightResult` can report `{ exactness: "unavailable", tokens: null, reason }`, for example when lazy tokenization reaches an unbased diff hunk without the prefix context needed to reconstruct diff-side state. Narrow on `exactness` before reading `tokens`. The default React renderer shows unavailable rows as unhighlighted authored source text while preserving diff markers.

- 45b29fb: Native list and blockquote streaming preserves current nested children in open dumps and Core cold exports. Nested code, table, and paragraph leaves update through existing owner patch families and generic child operations; authored ranges remain physical UTF-16 coordinates in the canonical input document.

  Primary list paragraphs use native paragraph deltas while cold exports preserve the existing item representation. Empty tasks retain their authored markers without rendering duplicate marker text, including after finalization.

  Keep provisional inline HTML and allowlisted MDX repair separate from authored source. Rejected HTML stays literal even inside formatted inline content; unclosed previews become literal at finalization without consuming later paragraphs.

  Preserve the canonical nested hierarchy during late link and footnote resolution. Publish targeted meaning updates with stable authored ranges and historical values, including generic heading metadata and links. Footnote numbering and occurrence anchors follow document reference order across nested paragraphs and table cells.

  Preserve table headers and alignments when CRLF arrives one UTF-16 unit at a time. Parse lone CR as a line ending without changing physical source offsets, invalidate affected incremental fragments when LF follows, and advance retired root paragraph generations across source-kind changes.

  Carry canonical generic ranges and metadata through existing property patches. Core and React apply metadata replacement, omission and explicit clearing consistently, without resurrecting stale block metadata or mutating historical exports. Preserve a list item's canonical source extent when retained marker context is shorter than its managed primary paragraph.

  Preserve completed paragraph leases when retained native marker context omits their body. Publish current HTML source ranges alongside sanitized content, and keep type-1 HTML, comments and processing instructions outside type-6/7 continuation recovery.

  Remove invalidated suffix reference definitions as titles arrive, and retire paragraph ownership when a footnote definition becomes complete. Native list child identity carries its canonical ordinal so ordered markers remain correct across bounded windows.

  Native code rows remain in their owned code index rather than a duplicate generic child tree. Native line ranges subscribe only to changed aligned ranges, including late decoration and provisional boundary completion.

  Keep completed list-item DOM mounted when list looseness changes; inherited presentation updates through the parent layout context. Current ancestor ordering epochs remain observable without restamping unchanged descendants, while stale updates are still rejected.

  Reuse typed container markers and list looseness in bounded native windows without reading completed item gaps. Preserve quote markers inside the changing paragraph and refresh marker-only opening lines before deriving their retained context.

  Explicit renderer resets and worker replacement start a fresh document baseline. Keep retired owner generations within that baseline, and invalidate native code-range demand and source actions across resets even when worker-local IDs and generations repeat. Ordinary appends retain their bounded range subscriptions.

  Normalize CRLF and lone CR for explicit cold container parsing and native fallback semantic extraction from canonical source. Retain untouched authored source, legitimate spaces, and physical UTF-16 child ranges, including nonzero source origins and astral characters.

  Apply sparse paragraph meaning updates only to affected index branches, preserving earlier snapshots and unchanged authored source. Plaintext projection accepts read-only prepared inline nodes without copying them.

  Keep MDX components finalized over their complete authored source. Retire absorbed paragraph and container leases before emitting further native updates, preserving unrelated batched changes.

  Honor configured lazy tokenization for native nested code. Advance grammar state through skipped source without coloring unrequested rows, and retain requested tokens through append, finalize and cold JSON reset.

  Do not republish a canonical root snapshot containing an already-published live nested code lease after its semantic owner updates. Preserve native lifetime guards and the unmanaged replacement path.

  Retire the `appendLines` wire operation, generic code-line producers and reducers, and obsolete coalescing telemetry. Native source and decoration changes use their typed code owner. Static version-1 cold artifacts remain unchanged.

- 4b66f9c: Replace the legacy `components` component map with `components?: NodePresentations`. Each semantic key maps to an entry containing constrained `props` and optionally either `wrapper: React.ComponentType<NodeViewProps>` or a headless `view: React.ComponentType<HeadlessNodeViewProps<K>>` (never both); `slots.actions` is supported for code and table presentations. Migrate `components={{ table: TableView }}` to `components={{ table: { wrapper: TableView } }}`, or register a headless code view as `components={{ code: { view: CodeView } }}`. New public types include `NativeNodeKey`, `NodePresentationKey`, `NodePresentation`, `NodePresentations`, `NodeViewProps`, `HeadlessNodeViewProps`, `NodeHandle`, `NodeHandleMetadata`, `NodeChildRange`, `NodeViewMetadata`, `NodeViewActions`, `PresentationProps`, and `NativeActionSlot`.
- 4ba8928: Retire `engine="main-thread"` in favor of `engine="main"` and reject the removed value with an actionable runtime migration error.
- 28f8a1e: Remove `blockRenderer` and the `BlockComponents` registry. Use `components: NodePresentations` for native block wrappers and views, including unified rendering.
- 71f76b2: Remove the legacy `CodeNodeViewProps` export; use `HeadlessNodeViewProps<"code">` instead.
- e6fff1e: Remove the fragmented renderer override props in favor of `components: NodePresentations`:

  - `inlineComponents` → `components["inline:<kind>"]` (for example `inline:link`, `inline:strong`).
  - `htmlElements` → `components["html:<tag>"]`, applied after HTML admission and sanitization.
  - `tableElements` → `components.table` and the table part keys.
  - `codeRenderers` → `components.code`; route by `metadata.language` and return the prepared `children` for other languages.
  - `mathRenderer` → `components["inline:math"]` / `components.math` for presentation.
  - `mdxComponents` → `contentComponents` for restricted source components, and the explicit trusted MDX engine provider for trusted MDX.

  `ComponentRegistry` now takes a single options object.

- 4173aec: `syntax` is now a versioned `SyntaxExtensionDescriptor` with `inline` rules and registered colon `containers` that share restricted-component admission.
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

  - **P9 Security & Architecture Cutover (Strict Restricted Components & Trusted MDX Lane)**:
    - The default reachable React package graph removes compiler/evaluator imports, dynamic imports, and root re-exports (`mdx-client`, `mdx-coordinator`, `mdx-prefetch`, `mdx-runtime`). The main root keeps pure Trusted-MDX contract types; the implementation is available only from `@stream-mdx/react/trusted-mdx`.
    - Removed per-block MDX compilation/evaluation machinery and obsolete props `mdxComponents`, `mdxCompileMode`, `mdxHydration`, and `artifactHtml`.
    - Introduced `contentPolicy` (`"markdown" | "restricted" | "trusted-mdx"`, default `"restricted"`) and `contentComponents` host registrations with strict prop validation.
    - Only serializable descriptors (`name`, `renderWhen`) cross the Web Worker boundary in `WorkerIn` `INIT`; host callbacks (`validateProps`, `component`) remain on the main thread.
    - Full MDX authoring requires caller-supplied `engines.mdx` from an explicitly configured trusted engine.
    - Removed automatic artifact-fence execution and the `ArtifactFrame` default renderer; `artifact` and `html-artifact` fences stay inert code unless the host explicitly supplies a code renderer.
      The remaining consumed changesets describe the new opt-in renderers, controls, animation, table virtualization, themes, native extension APIs, and correctness/security fixes. These features do not enable themselves when upgrading. See the root README migration section and the generated package changelogs before upgrading custom integrations.

### Minor Changes

- 79560b9: Add `mathOptions={{ macroScope: "document" }}`, an explicit KaTeX macro scope owned by one document generation. Complete expressions apply `\gdef` definitions in document order, provisional expressions commit nothing, and replacing or restarting the document clears the scope. Expressions stay isolated by default. KaTeX now always renders with `trust: false`, `maxExpand: 1000` and non-throwing error output.
- 049f2e5: Add the `engines.math` capability for synchronous custom TeX rendering while keeping KaTeX as the default. Math presentations remain view-only wrappers around the selected engine output.
- 67b9728: Add a bounded viewport for large native code blocks with an opt-in full-content reader mode. `codeVirtualization` configures native code viewport presentation, including optional tail following; updates preserve the existing viewport and reader anchor. Eligible virtualized code blocks mount full source before printing and restore the previous viewport, anchor, and native selection afterward.

  Native whole-code copy and download use cold authored source, preserving CR/LF and trailing blank lines instead of normalized display text. The test DOM exercises copy with an active selection and a Clipboard API stub; it does not prove physical browser or OS clipboard behavior. Direct Blob download browser proof remains pending. Copied-status feedback cleanup prevents delayed updates after unmount.

- 3101916: Export `NativeNodeView` from `@stream-mdx/react/server` so headless views rendered by the server `MarkdownBlocksRenderer` can fall back to native output. `table-row`, `table-cell` and `component:<Name>` presentations accept only `wrapper` and `props`, both in the types and at `ComponentRegistry` construction; customize tables headlessly through `components.table.view` with `useTableBlock` and `useTableRows`.
- 31c997f: Add the native root theme policy, isolate native output styles and custom properties, and map Shiki light/dark foreground, background, font-style, font-weight, and text-decoration tokens to the selected color scheme.
- afcce56: Render up to 4,096 accepted UTF-16 source units through the existing inline engine during `auto` startup, without waiting for worker or grammar readiness; defer further source beyond the bootstrap budget.
- 736c767: Export `EngineCompatibilityError` for automatic takeover failures when workers are unavailable.
- 61aa9d1: Take over the 4,096-unit auto bootstrap with a cold worker reconstruction, preserving the visible projection and accepted source order until the worker commits the matching source frontier.
- 1d6026c: Add an optional coarse-grained polite status region and preserve exact authored code selection and download bytes.
- fceb3e5: Expose code-engine adapters across the main and custom worker realms, preserve worker adapter tokens in emitted code-line output, and document their compatibility requirements.
- 925ca3e: Expose finalized state in inline and HTML node presentation metadata.
- 49efd0e: Add inline and allowed-HTML node presentation wrappers and headless views through the `components` registry. Preserve safe URL transformation, attribute normalization, sanitization, and element filtering before presentation dispatch.
- aca45df: Allow `components["inline:math"]` wrappers and headless views to present inline and display math while retaining the existing math engine output as prepared children.
- 59622ba: Add `components: NodePresentations` to static/server and unified rendering, using the same native-node wrapper/view dispatch as streaming. Unified's HAST element mapping moves to `hastComponents`.
- 7f65556: Add an inert preview slot and generation-bound node revision feeds for explicitly installed host runtimes.
- 3fca012: Add owner-local table handles and bounded React hooks for stable table metadata and ranged body-row subscriptions.
- bc8bb58: Export `useNode`, `useNodeChildren`, and `NativeNodeView`. Node hooks read generation-bound metadata and explicit half-open child ranges; native fallback bypasses the current presentation entry so headless views can render prepared native children without recursion.
- bbfb021: Export `useCodeDiff` for observing diff status and prepared code rows within an explicit half-open range. The hook reuses code-line records and avoids rerendering when metadata changes without changing the selected diff status or rows.
- 072e0f1: Expose generation-bound source reading and resolved link-reference metadata to node presentations, and report unified failures with block ID, type, and finalized state.

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

- 721313b: Reject patches that would make a node its own ancestor, and record an invariant diagnostic instead of looping.
- e4c905f: Finish background tokenization of finalized lazy code blocks shown in the bounded code viewport. Visible rows are still served first, and `lazyTokenizedUntil` now reaches the full line count.
- 521be6f: Count code decorations computed for a superseded owner generation as stale work instead of invariant violations. They are still dropped. Decorations for an unknown owner or a newer generation are still diagnosed.
- a9052cb: Honor reduced-motion preferences for bottom jumps and let wheel, touch, and scroll-key input interrupt smooth returns.
- 3f24715: Bound host-accepted and in-flight source with generation-tagged worker admission acknowledgements. Imperative append accepts a whole UTF-16 chunk or refuses it without partial admission; automatic iterators losslessly split larger chunks and wait for capacity.

  Finalization seals the host generation immediately and resolves one shared promise after all earlier accepted source reaches the matching native finalization and semantic store barrier. Reset invalidates pending capacity/finalization waits, including automatic source replacement on a reused renderer. The barrier does not imply a React commit or optional enrichment readiness.

  Cache inline regex eligibility per immutable parser context, rather than rescanning the whole context at each token position. A later marker-bearing context still performs its own check, and weak keys do not retain completed contexts.

  Demo automation now observes synchronous source and completion state immediately after fast-forward or finalization, and restart opens a fresh wrapper session before replacing its worker.

- e7b4a0c: Reject reads from a code-node handle after its owning code document is replaced or removed; retained immutable range snapshots remain valid independently.
- ccfd10b: Preserve authored line endings when copying selections that end at rendered code separators.
- 7cd811e: Preserve incomplete code-line provisional state in cold exports only while the block is still open.
- 831a29d: Preserve authored Markdown source when copying or downloading cold table views.
- a0a3bd2: Restore all rows and unclipped viewport styles while printing cold table views.
- 78753b7: Preserve authored leading plus characters when projecting diff line tokens into presentation metadata.
- e2303e9: Render default KaTeX math from inert authored source during SSR and the initial client render, then prepare KaTeX after commit. Keep prepared output and errors tied to the TeX and display mode that produced them.
- 072e0f1: Add an optional Mermaid engine capability that routes Mermaid fences through the native code owner while Markdown parsing remains in the selected worker or main-thread engine.
- 7767c9e: Apply constrained node presentation props to the native element across block render paths, including headings.
- 68b4b27: Apply presentation props to registered restricted components and reject unsupported headless component views.
- 4a8509d: Unescape `\|` in table cells on every table path, including streamed root and nested tables.

  Stream the body rows of a table nested in a quote or list item from the container's own parse, and seal an unterminated last row at finalize instead of dropping it. A container window keeps the separating lines before a nested table's context lines.

  A container replacement in the renderer store keeps the table and paragraph owners it carries forward, so a quote holding a table and a following block no longer loses its content when it finalizes.

  Retract a provisional empty list item once its line completes as a thematic break.

- 7c47cf1: Reject an automatic takeover append before accepting its source when worker creation fails.
- 355c068: Start automatic worker takeover when code highlighting is requested so short code blocks receive worker decorations on finalization.
- fd6f456: Render complete static input in auto mode and report its full accepted-source frontier.
- 1e18f9e: Schedule presentation work through animation frames by default and limit semantic commits to cooperative 4 ms slices before lower-priority enrichment.
- 7f00a2c: Settle waiting source-capacity requests when automatic bootstrap takeover initialization admits the existing source frontier.
- c1666b8: Bind automatic bootstrap takeover failures to their initiating request so an obsolete worker lease cannot fail a replacement source session.
- df89989: Prioritize visible and rendered overscan code ranges ahead of full-block background tokenization.
- 8a081d5: Skip block presentations when element filters drop or unwrap their native host element.
- 2e71146: Avoid emitting managed table shells and controls when element filtering removes the table.
- 1a85e7a: Allow code and table headless views to select the matching native node projection with `NativeNodeView`.
- f394b1e: Dispatch table-row and table-cell presentations across managed, static, and virtualized table rendering.
- 1e8f261: Bind node metadata subscriptions to the captured record and generation, rejecting stale registration and suppressing notifications after replacement.
- 127dd84: Reject saved table-wrapper actions after their table owner is replaced or reset.
- 9d1ef66: Apply registered component presentations to validated restricted content elements.
- c6fb34f: Dispatch headless code presentations from unified rendering.
- 9616242: Keep code-line consumers subscribed to their selected line range rather than unrelated owner metadata.
- 3f24715: Reuse completed root block records during native tail parsing and clone only unfinished or affected container snapshots at EOF. Custom document plugins retain isolated previous snapshots. This reduces snapshot copying while preserving authored content and semantic lifecycle ordering.

  Keep generic roots and native code, table, and paragraph owners in source order when emitting absolute root child indexes. A later generic heading no longer precedes an earlier native paragraph or displaces retained footnote/HTML roots.

  Admit newly reached native code fences even when earlier code owners already exist. Seek admission from the changed root suffix and skip existing source starts before allocating owners. Mixed CR/LF input invalidates the adjacent unfinished parse fragment, while derived indented-code text uses normalized newlines without changing authored raw source.

  Reopened native lists and blockquotes publish a bounded semantic finality transition. EOF emits the matching finalize operation for reparsed native suffix roots even when earlier completed records are retained. Core snapshots and the React store keep this finality in canonical block state rather than presentation props. During EOF finalization, retained-prefix indices are operation-local and are reused only after source-boundary validation against the current array; stale indices fall back to binary search.

  Keep semantic and enrichment `setProps` deliveries separate when merging or batching. Discarding late code enrichment no longer discards an adjacent canonical container-finality transition.

  Reject semantic output from an older parse epoch even when its stream sequence is higher. Direct document-plugin registry registration receives the same previous-snapshot isolation as constructor-installed plugins, including finalized prefix blocks reused by the generic append path.

- 3f24715: Require each live worker PATCH and every schema-2 protocol event to carry its native root document generation. Renderers and TUI event stores reject stale-generation work against the current validated INITIALIZED baseline, including after queueing; TUI replacement also clears old transaction/status metadata. Caller-managed worker attachment stays pending until an observed baseline, then drains accepted input once. Node and direct snapshot compilers bind patch/finalization handling to that baseline. Static snapshot artifacts remain version 1.

  Explicit cold TUI replacement retires the old native lease, so delayed snapshots and lifecycle events cannot reclaim the replacement. A validated newer same-stream baseline can resume delivery.

  Bind same-turn restart capacity waits to the new session's admitting renderer, retaining their requested capacity and cancellation options without dropping accepted source.

  Use the task-packed protocol dependency in installed Node, Next, and Vite smoke consumers instead of allowing a registry fallback.

  Generate JavaScript for both installed runtime loaders and replay a replacement root's actual finalization patches before checking completed source.

  Render the terminal example from authored cold block source without adding duplicate heading, quote, or code-fence markers.

- 246c834: Bind retained streaming handles to their session generation and reject stale or disposed operations with `StreamSessionError`.
- de787ea: Initialize code follow-tail attachment from the viewport's physical bottom distance on mount.
- 8c889df: Make `waitForIdle()` wait for the current source session's worker admission and patch commits before returning.
- 6d9792e: Reject source reads from retained node presentations after their owner is reset, removed, or updated.
- 4af3faa: Normalize scrollable table presentation wrappers during virtualization, then restore their authored overflow styles when virtualization ends.
- 7ba4a6b: Preserve the detached visible table row and its pixel offset when measured row heights change, including rows partly covered by the sticky header. Keep bottom-following behavior for attached viewports. Reset the viewport and discard its geometry when the root source document is replaced, while retaining anchors across same-document appends.

  Add an accessible per-table "Show full content" toggle for virtualized tables. It mounts all rows only on request and restores bounded windowing while retaining the native viewport, table, selection endpoints, measured columns, and scroll position.

  Native table Markdown copy and download use the owned authored source slice, preserving spacing, escapes, inline Markdown, and original line endings while excluding the final row's line ending and following document content. TSV and CSV remain cell-value transforms. The public consumer regression clicks the copy button in JSDOM with a stubbed Clipboard API; it does not verify a physical browser or OS clipboard. Markdown download shares the source-selection path, but its Blob/browser handoff, PDF, and speech output were not exercised.

- Ensure finalized native and custom lazy code blocks request fresh full-range tokenization after document or code-epoch replacement, including identical source with reused block IDs and progress counts. Keep progress deduplication within the current lifetime.

- Verify coalesced patches through raw, linear, and quadratic consumer replays. Keep the 10% minimum on the controlled 60-update redundant-title case with exact final value `value-59`; real-snippet reduction remains telemetry, with retained coalescing counters and duration validated against aggregate totals (capped retained windows may undershoot), alongside the existing 8 ms coalescing-duration p95 guard.

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
