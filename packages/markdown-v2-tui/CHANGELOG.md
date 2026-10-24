# Changelog

## 1.0.0

### Major Changes

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

### Patch Changes

- 3f24715: Require each live worker PATCH and every schema-2 protocol event to carry its native root document generation. Renderers and TUI event stores reject stale-generation work against the current validated INITIALIZED baseline, including after queueing; TUI replacement also clears old transaction/status metadata. Caller-managed worker attachment stays pending until an observed baseline, then drains accepted input once. Node and direct snapshot compilers bind patch/finalization handling to that baseline. Static snapshot artifacts remain version 1.

  Explicit cold TUI replacement retires the old native lease, so delayed snapshots and lifecycle events cannot reclaim the replacement. A validated newer same-stream baseline can resume delivery.

  Bind same-turn restart capacity waits to the new session's admitting renderer, retaining their requested capacity and cancellation options without dropping accepted source.

  Use the task-packed protocol dependency in installed Node, Next, and Vite smoke consumers instead of allowing a registry fallback.

  Generate JavaScript for both installed runtime loaders and replay a replacement root's actual finalization patches before checking completed source.

  Render the terminal example from authored cold block source without adding duplicate heading, quote, or code-fence markers.

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
  - @stream-mdx/protocol@1.0.0

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
  - @stream-mdx/protocol@0.5.0

## 0.1.1

- Initial release with NDJSON helpers and snapshot store.
