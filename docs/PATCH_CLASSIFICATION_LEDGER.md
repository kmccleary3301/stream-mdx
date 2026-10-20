# Patch Classification Ledger

_Last updated: 2026-04-10_

This ledger is the canonical semantic/enrichment map for the `Patch` union in
`packages/markdown-v2-core/src/types.ts`.

If a patch family is not classified here, it is not considered part of the
stable semantic-envelope contract.

## Contract

Every patch family must satisfy exactly one of these states:

| State | Meaning |
| --- | --- |
| `semantic` | changes visible meaning, structure, ordering, finalized state, or block identity |
| `enrichment` | decorates already-correct semantic output without changing meaning or structure |
| `invalid` | not allowed in active worker/runtime flows until an audited use case exists |

Ambiguous work defaults to `semantic`.

## Patch Family Map

| Patch op | Default class | Explicit enrichment allowed? | Notes |
| --- | --- | --- | --- |
| `insertChild` | `semantic` | No | Changes committed tree topology and block identity |
| `deleteChild` | `semantic` | No | Removes committed semantic content |
| `replaceChild` | `semantic` | No | Replaces committed semantic structure or ordering |
| `setProps` | `semantic` | Yes | Default remains semantic; explicit enrichment is only allowed for audited decoration-only updates |
| `setPropsBatch` | `semantic` | Yes | Same rule as `setProps`; the batch-level patch meta owns classification |
| `finalize` | `semantic` | No | Changes finalized visible state |
| `reorder` | `semantic` | No | Changes committed ordering |
| `appendLines` | `semantic` | No | Changes committed code-line structure and visible content |
| `appendCode` | `semantic` | No | Atomically replaces the unfinished code tail and advances its exact authored-source frontier; never carries completed-prefix records |
| `appendTableRows` | `semantic` | No | Atomically replaces only the provisional tail and appends stable table rows under owner generation, source revision and exact source-frontier guards |
| `updateTableRows` | `semantic` | No | Applies dependency-targeted inline meaning changes to unchanged row/header source identities under one atomic owner revision gate |
| `decorateCode` | `enrichment` | Only | Revision-matched line decoration; cannot change source, line topology or lifecycle |
| `setHTML` | `semantic` | Reserved only | `setHTML` carries `patchMeta`; explicit enrichment is reserved and currently not used by the worker |

## Allowed Explicit Enrichment Families

The following are the only currently-audited explicit enrichment paths:

| Patch form | Source | Why enrichment is safe |
| --- | --- | --- |
| `setProps` | finalized code lazy tokenization follow-up | updates highlighted line metadata/HTML without reopening finalized block semantics |
| `setPropsBatch` | future multi-node decoration-only updates | reserved for coalesced decoration-only updates; still defaults to semantic unless explicitly audited |
| `decorateCode` | owned code highlighting and range follow-up | owner/generation/configuration guards plus each row's identity and source revision prevent stale decoration from changing source |

`setHTML` enrichment is intentionally not part of the current runtime allowlist.
If a future path needs it, the path must be added here with tests before use.

## Patch Family Rationale

### `insertChild`, `deleteChild`, `replaceChild`, `reorder`

These operations change committed tree shape or ordering. They are always
semantic and must stay in atomic semantic batches.

### `finalize`

`finalize` changes block lifecycle state and therefore visible semantics. It is
always semantic and epoch-guarded.

### `appendLines`

`appendLines` is an optimization for code blocks, but it still mutates visible
line structure. It is semantic and only allowed when append safety is provable.
Any ambiguity falls back to semantic replace.

### `appendCode` and `decorateCode`

`appendCode` is always semantic, including lifecycle-only changes with no new
display rows. It validates the expected source revision, unfinished-tail boundary,
line counts and exact authored `sourceAppend` before committing. Initial or cold
replacement snapshots may carry full source; routine appends may not.

`decorateCode` is always enrichment. It carries no source or structural replacement.
A later tail append does not invalidate an unchanged completed row: guard the code
owner, generation and configuration, then validate each row's identity and last
source-change revision independently. A stale row may be dropped without discarding
other valid rows. Patch metadata cannot reclassify either operation.

### `appendTableRows` and `updateTableRows`

`appendTableRows` is always semantic. It carries only the previous provisional
tail replacement and newly committed rows, plus the exact authored source append.
Owner generation, expected revision, row frontier and source ranges are checked
before the index changes; completed prefixes remain immutable.

`updateTableRows` is also semantic, never decoration: reference, footnote or
numbering invalidation can change rendered meaning after row commitment. It may
carry only affected rows and an optional changed header. The source identity,
raw slices, ranges and row revisions remain fixed; a header-only update has an
empty row update list and never walks or replaces body rows. The entire command
is rejected when its owner generation or expected revision is stale.

`appendTableRows` advances an append-only private source log while each accepted
view exposes an immutable prefix bounded to its current `sourceRange`. A valid
provisional-tail retraction shortens only that view; it never truncates the log.
Re-extension verifies overlap inside the previously logged unfinished tail and
appends only bytes not yet present. `processedTo` remains monotonic across both
transitions.

`closed` means the native table block prefix is committed while document input may
continue. It is distinct from worker `FINALIZED`; dependency invalidation may
target a closed table during live input, but same-generation updates to a
`finalized` table are rejected.


### `setProps`

`setProps` is semantic by default because it can replace full block payloads and
therefore meaning, ordering, or finalized state. It may be explicit enrichment
only when it updates already-correct decoration-only data.

Current audited enrichment uses:

- finalized lazy code highlighting metadata

Current audited semantic uses:

- finalized MDX status transitions
- block payload replacement
- semantic reparses

### `setPropsBatch`

`setPropsBatch` is semantic by default for the same reason as `setProps`. The
batch-level meta owns classification because grouping must remain atomic.

This op is allowed to become enrichment only when every entry in the batch is
decoration-only and the emitting path is explicitly audited.

### `setHTML`

`setHTML` is semantic by default because it replaces visible HTML content.
Although the type supports explicit `patchMeta.kind`, the current runtime does
not rely on `setHTML` enrichment. Treat that space as reserved, not active.

## Current Runtime Guarantees

- semantic batches receive `streamSeq`, `parseEpoch`, `tx`, and target
  `blockEpoch` where applicable
- enrichment may be coalesced or delayed, but must not reopen finalized
  semantics
- stale semantic patches are rejected in the renderer store
- post-finalize visible mutation paths are governed separately by
  `docs/POST_FINALIZE_MUTATION_LEDGER.md`

## Guard Coverage

Classification and envelope coverage currently lives in:

- `packages/markdown-v2-core/__tests__/patch-batching-kind.test.ts`
- `packages/markdown-v2-worker/__tests__/worker-patch-metadata.test.ts`
- `packages/markdown-v2-worker/__tests__/worker-post-finalize-boundary.test.ts`
- `packages/markdown-v2-react/__tests__/patch-commit-scheduler-semantic-order.test.ts`
- `packages/markdown-v2-react/__tests__/post-finalize-store-boundary.test.ts`

If a new patch family or explicit enrichment path is introduced, it must update:

1. this ledger
2. the correctness contract
3. at least one direct test
