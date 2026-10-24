# @stream-mdx/theme-tailwind

## 1.0.0

### Major Changes

- 31c997f: Add the native root theme policy, isolate native output styles and custom properties, and map Shiki light/dark foreground, background, font-style, font-weight, and text-decoration tokens to the selected color scheme.

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

- 24f5b42: Apply the theme's typography rules inside native `[data-stream-mdx]` roots. The roots' `not-prose` class had also excluded the theme's own paragraph, blockquote, list, table and code spacing. Nested `not-prose` islands and host content outside a root stay excluded.

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

- 2662bce: Map Shiki dual-theme token variables (`--shiki-light*` / `--shiki-dark*`) to colors inside `.markdown-v2-output`, so highlighted code is readable in light mode and switches to dark tokens under a `.dark` ancestor.

## 0.5.0

### Minor Changes

- Promote the current hardening and product-surface tranche as `0.5.0`.

  This release rolls up:

  - renderer/store correctness hardening
  - seeded smoke and scheduler-parity release discipline
  - benchmark methodology and comparison cleanup
  - docs, showcase, and TUI/product surface maturation

## 0.1.1

### Patch Changes

- Initial release with StreamMDX Tailwind theme styles.
