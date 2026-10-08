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

Footnote numbering runs over the actual prepared inline children in document
order. It updates serialized child views and existing HTML ownership descriptors
without changing unrelated code/HTML artifacts. Blockquote compatibility inline
is derived from those numbered children, not reparsed from container source.

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

Package builds and all 20 core test files passed. The worker suite stopped on
mixed-segment canonicalization and the React suite stopped on HTML consumer
conformance. The final source canonicalizes prepared nested metadata for JSON
parity. The owning-engine regression checks native callbacks, declarative syntax,
forward references, child finalization, serialized reset, code-line counts, and
core/React consumer invariants. Full worker/React approval still requires the
integration gate; the conformance counts above are not a parity claim.



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

## Runtime fallback

When a snapshot file is missing or disabled by mode flag, docs routes fall back to the existing `StreamingArticle` worker render path.
