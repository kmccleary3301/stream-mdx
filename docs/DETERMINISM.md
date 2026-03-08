# Determinism Contract

This repository treats "determinism" as a product requirement.

StreamMDX must produce identical final outputs for the same:

- input content
- engine/config flags
- worker bundle build
- dependency versions (notably Shiki themes/grammars)

This contract exists so StreamMDX can be safely used across contexts:

- browser (WebWorker)
- Node (worker_threads)
- SSG/SSR builds (Vercel)
- (future) Edge runtimes

## Scope: What Must Be Deterministic

Given the same:

- `content` (byte-for-byte input string)
- `config` (doc plugins, highlighting modes/output, sanitization, MDX mode)
- `engineVersion` and `workerBundleSha`

StreamMDX guarantees:

1. Final `Block[]` determinism
   - Identical block ordering, ids, types, and payload semantics across runtimes.

2. Patch semantics determinism
   - For the same chunk boundaries: patch operations are identical.
   - For different chunk boundaries: intermediate patches may differ, but the final `Block[]` must match.

3. TOC determinism
   - Engine-derived heading ids are stable (`slugify(text)` plus collision suffix rules).
   - TOC heading ordering is stable (document order).

4. Sanitization determinism
   - Sanitized HTML output is identical for the same input and schema.

## Allowed Nondeterminism

These fields may vary and must not be used as control flow or cache keys:

- performance timing metrics and scheduling boundaries
- debug-only telemetry payloads

## Guardrails

Hidden sources of nondeterminism to avoid:

- locale-dependent sorting or collation
- unstable hashing
- dependency drift (Shiki grammars/themes, sanitizer behavior)
- differing MDX compilation pipelines between worker/server modes

## How We Test It

We keep a "matrix" harness that runs the same fixture through:

- Node worker_threads (hosted bundle under shims)
- Browser WebWorker (Playwright)

and compares normalized `Block[]` output.

Run:

```bash
cd stream-mdx
npm run determinism:matrix
```

You can choose a fixture:

```bash
cd stream-mdx
npm run determinism:matrix -- --fixture=tests/regression/fixtures/kitchen-sink.md
```

## Invariants -> Enforced Tests

### Heading + TOC determinism

- Invariant: heading IDs are stable and collision-safe across contexts and chunking.
- Coverage:
  - `tests/determinism/fixtures/toc-collisions.md`
  - `tests/determinism/fixtures/inline-code-headings.md`
  - `tests/determinism/fixtures/heading-slug-policy.md`
  - `packages/markdown-v2-worker/__tests__/worker-heading-id-conformance.test.ts`
  - `scripts/determinism/run-worker-matrix.ts` (compares heading anchors + `tocHeadings`)

### Cross-context final block parity

- Invariant: final `Block[]` output is equal for Node worker_threads and browser worker.
- Coverage:
  - `scripts/determinism/run-worker-matrix.ts`
  - `packages/markdown-v2-worker/__tests__/worker-compile-parity.test.ts`

### Snapshot hash determinism

- Invariant: `hash`, `contentHash`, `configHash` are stable for identical input/config/salt.
- Coverage:
  - `packages/markdown-v2-worker/__tests__/node-snapshot-hash-contract.test.ts`

### Snapshot schema compatibility

- Invariant: unsupported old cache schema versions are treated as cache misses and regenerated.
- Coverage:
  - `packages/markdown-v2-worker/__tests__/node-snapshot-cache-legacy.test.ts`

### HTML parity (server render vs browser final DOM)

- Invariant: static/server renderer output matches browser final state for supported fixtures.
- Coverage:
  - `scripts/determinism/html-parity.ts`
  - command: `npm run determinism:html-parity`
