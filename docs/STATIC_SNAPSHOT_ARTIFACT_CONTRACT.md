# Static Snapshot Artifact Contract

This document defines the artifact format produced by `npm run docs:snapshots:build` for StreamMDX docs pages.

## Purpose

- Compile markdown at build time using the same deterministic worker pipeline.
- Persist stable block snapshots for static docs rendering.
- Keep a fast fallback path to runtime streaming rendering when needed.

## Artifact location

- Root: `apps/docs/.generated/snapshots/`
- Docs page artifact: `apps/docs/.generated/snapshots/docs/<slug>.json`
- Guides page artifact: `apps/docs/.generated/snapshots/guides/<slug>.json`
- Manifest: `apps/docs/.generated/snapshots/manifest.json`

## Artifact schema (`version: 1`)

```json
{
  "version": 1,
  "schemaId": "streammdx.snapshot.v1",
  "createdAt": "2026-02-09T00:00:00.000Z",
  "hash": "sha256_of_input_and_init_payload",
  "contentHash": "sha256_of_markdown_text",
  "configHash": "sha256_of_compile_init_and_salt",
  "hashSalt": "optional_caller_provided_salt",
  "blocks": [],
  "tocHeadings": []
}
```

## Determinism guarantees

- `hash` is computed from markdown text + compile init options + optional `hashSalt`.
- Identical input and init produce identical artifact hashes.
- Renderer output uses `blocks` and does not depend on stream chunk boundaries.
- `tocHeadings` is derived from block metadata, not DOM reads.

## Nested block ownership

List and blockquote `payload.meta.preparedNested` contains `{ props, children }`, where
`children` is a serialized `NodeSnapshot[]` in source order. The owning engine uses
its configured block parser and actual inline parser instance to prepare these
children. Native plugin conversion callbacks are never reconstructed from JSON.

Core snapshot consumers and React stores reuse this structure after transport or
JSON serialization. Nested blocks retain `sourceContainer` metadata, absolute
source ranges, and their container's finalization state. Reference-definition
updates re-enrich the container, including nested headings and list items.

Nested code contains normalized `meta.code`, normal highlight metadata, and
`code-line` children before patch emission. Renderers do not need to reparse code
or repair a line-count mismatch to reconstruct a static snapshot.

Nested lazy highlight requests use the code descendant ID on the existing
`TOKENIZE_RANGE` transport. The owning engine resolves that prepared leaf,
including markdown block slots in `htmlTree`, and updates its owning root plus
serialized ancestor snapshots. Incremental core and
React consumers receive updated code-line colors, highlight metadata, and custom
code-renderer props without a separate parser or renderer line-count repair.
Appending content retains lazy state for prepared code descendants still present
in the document.

`INIT` and disposal invalidate in-flight lazy work, even when a replacement
document reuses descendant IDs. Before committing, the engine checks the original
leaf's immutable code source and language/theme policy, and resolves its current
owning root and index. Reconstructed equivalent leaves can complete; changed code
is discarded. Grammar state, diff cursors, and line rows are committed only after
these checks. Copy-on-write ancestor updates and newly appended siblings remain intact.

Public token spans use `fg` and `fs` in their compact style records. Theme variants
remain in `v.dark` and `v.light`; the legacy themed-line bridge converts these
fields to `color` and `fontStyle` rather than exposing those legacy keys in token IR.

Serialized code rows and `appendLines.diffKind` use the public `DiffLineKind`
discriminants (`add`, `del`, `context`, `hunk`, `meta`). Parser-only `DiffKind`
uses `remove` internally; full and lazy highlighting normalize it before publication.

Patch control metadata uses the existing `semantic` and `enrichment` classes.
`setHTML` reads control fields from `patchMeta`, separately from HTML content
metadata. Shiki languages are checked against its native registry and special
language identifiers before loading; unknown requested languages retain the text
fallback.

Footnote numbering uses the current canonical rendered document: root references
first, then reachable definition bodies in footer order. Late root references may
renumber earlier body-only references; final IR is independent of append chunking
and prior finalization. Reference links and footer items update together.
Serialized aliases do not create extra occurrences. Blockquote compatibility
inline follows the same HTML, prepared child, table-cell, and mixed-segment
ownership paths, without reparsing container source or copying unrelated artifacts.

Defined footnote occurrences carry `occurrence` and `defined` metadata. The first
anchor is `fnref:n`, subsequent anchors are `fnref:n:2`, `fnref:n:3`, and so on.
Footer items carry their actual `refCount`; each backlink targets its own
occurrence. Missing references remain literal and create no empty footer item.

While a dirty tail suppresses the footer, `defined` is false and references render
literally even in finalized earlier blocks. Intermediate fidelity checks compare
that one footer-dependent flag against current publication, preserving label,
number, occurrence, raw content, and all child metadata. Earlier public snapshots
remain unchanged through copy-on-write. After `FINALIZE`, full IR and footnote SSR
must match complete compilation; every rendered link must resolve to its own
definition or occurrence, with no premature or duplicate anchors.

### Block packet verification, October 2026

The saved pre-packet report counted 622/675 client-static and SSR passes,
620 streaming passes, and three streaming divergences. The hosted-worker run
after the nested cutover counted 652/675 static and SSR passes, 651 streaming
passes, and one divergence. These counts include the merged HTML and link work,
not just the block changes.

All three consumers passed assigned CommonMark examples 5, 6, 7, 10, 61, 131,
134, 137, 218, 251, 259, 264, 273, 274, 278, 280, 300, and 324. The run failed
the existing baseline on examples 155, 239, and 240; example 155 remained the
streaming divergence. Empty-quote 239/240 and empty-table-body GFM205 corrections
were applied after that report and require the parent integration gate.

Earlier worker/React suites stopped on mixed-segment and HTML conformance.
Subsequent block-source checks passed all 20 core files and all 46 worker files
at the earlier `1db243c` snapshot. Those results do not approve later integration.

At the canonical-footnote/code-row repair, core/plugins/worker package builds and
the hosted-worker build passed. Targeted tests passed:

- Six nested lazy-highlight cases: token/both output across list/quote, list-owned
  HTML, and root HTML; 220 producer rows, head/tail requests, callback metadata,
  JSON reset, append/finalize retention, and exact core/React consumer invariants.
- Public compact-token dark/light and native diff consumers against independent
  Shiki foreground/font-style results.
- The 51-line multi-await diff lifecycle fixture: replacement `INIT` with reused
  IDs, disposal, fresh copy-on-write owner metadata, inside-owner reconstruction,
  and continuation rows/cursors matching full compilation.
- Incremental code/HTML/math/MDX artifacts mounted through the real consumer.
- Three canonical footnote fixtures across all-at-once, interleaved finalization,
  and one-character appends: exact final IR/SSR, mounted DOM target identity,
  unique anchors/backlinks, and paragraph/table HTML-owned quote compatibility.
- All 17 streaming-fidelity scenarios with publication-aware intermediate checks,
  unchanged final structural/SSR comparisons, actual anchor target identity, and
  copy-on-write preservation of earlier consumer snapshots.
- Public direct compilation before and after another worker transport replaced
  global bindings: exact output retained, globals unchanged. Worker/public-engine
  ESM/CJS/declaration builds and hosted build passed; Node 20.20.2 public ESM and
  CJS direct/engine probes both passed. The targeted direct-parity and footnote
  consumer tests also passed after the direct runtime ownership repair.

The earlier 401-line alternating-run lifecycle fixture exhausted the Node heap;
the bounded replacement retains the lifecycle boundary but is not a memory
performance proof. Integrated full worker/React and hosted conformance gates
remain the parent integration evidence, not implied by targeted passes above.



## Heading ID policy (normative)

`tocHeadings[].id` and heading block `payload.meta.headingId` must follow the same deterministic policy:

1. Start from normalized heading text (`payload.meta.headingText`).
2. Lower-case.
3. Remove ASCII control chars (`U+0000`..`U+001F`).
4. Replace every run of non `[a-z0-9]` characters with `-`.
5. Trim leading/trailing `-`.
6. Collapse repeated `-` to a single `-`.
7. Empty result falls back to `heading`.
8. Repeated IDs in document order use numeric suffixes:
   - first: `id`
   - second: `id-2`
   - third: `id-3`

Notes:

- This policy is intentionally ASCII-stable across runtimes.
- TOC IDs and rendered heading IDs must always match for anchor integrity.
- Every TOC record carries the actual owning heading `blockId`. Identity changes
  participate in TOC patch signatures even when text and slug stay the same.

## Schema evolution / migration policy

- New schema versions must increment `version` and `schemaId` together.
- Readers may accept older versions only via an explicit compatibility branch.
- If compatibility is not implemented, old artifacts must be treated as cache misses and regenerated.
- Any schema change must include:
  - contract doc update,
  - regression test for previous-version behavior,
  - release note entry.

## Build integration

- `npm run docs:build` and `npm run docs:dev` run `docs:snapshots:build`.
- Pages default to snapshot render mode unless `STREAM_MDX_DOCS_ARTICLE_MODE=streaming`.

Direct compilation owns a private engine and output queue. It does not install or
reuse global `self`/`postMessage` transport bindings. Another worker runtime may
replace those bindings without redirecting direct compilation output. Existing
compile serialization, artifact hashes, and cache behavior remain unchanged.

Public imports and direct/worker compilation also leave `document` and
`DOMParser` unchanged. The obsolete ambient worker DOM stubs have been removed.
Node SSR uses the actual DOM-free HTML/sanitizer paths; physical workers compile
MDX through the existing DOM-free dependency aliases. Browser hosts retain their
real DOM rather than receiving an incomplete replacement.

Owner regression evidence at `c336251` (Node 26.3.0): both fresh public package
formats, ESM and CJS, passed unchanged global-descriptor checks for `window`,
`document`, `DOMParser`, `HTMLElement`, and `Node`. Direct and physical hosted
worker compilation produced identical final blocks for balanced MDX components,
case-sensitive `<Input>`, decoded entities, math, and quote-owned fenced code.
All three targeted scripts passed: `worker-dom-free-public-imports`,
`direct-compile-parity`, and `mdx-component-region-ownership`. The first also
renders the public React component in Node SSR without installing DOM globals;
that check establishes import/SSR safety, not rendered MDX-content parity.
Node 20 public-package and real-browser application gates remain integration
checks rather than evidence from this owner run.

## Runtime fallback

When a snapshot file is missing or disabled by mode flag, docs routes fall back to the existing `StreamingArticle` worker render path.
