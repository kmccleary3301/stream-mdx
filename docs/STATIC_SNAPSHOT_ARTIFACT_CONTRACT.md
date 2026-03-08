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
