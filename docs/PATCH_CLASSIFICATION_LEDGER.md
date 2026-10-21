# Patch Classification Ledger

_Last updated: 2026-10-21_

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
| `appendInputSource` | `semantic` | No | Retains exactly the newly admitted root input bytes at a UTF-16 offset; ordered and non-coalescable |
| `appendCode` | `semantic` | No | Atomically replaces the unfinished code tail and advances its exact authored-source frontier; never carries completed-prefix records |
| `appendParagraph` | `semantic` | No | Replaces only the changed paragraph span tail and carries the exact authored source suffix under owner generation and expected revision guards |
| `updateParagraphSpans` | `semantic` | No | Updates dependency-affected prepared paragraph meaning while preserving source identity under owner and span revision guards |
| `appendTableRows` | `semantic` | No | Atomically replaces only the provisional tail and appends stable table rows under owner generation, source revision and exact source-frontier guards |
| `updateTableRows` | `semantic` | No | Applies dependency-targeted inline meaning changes to unchanged row/header source identities under one atomic owner revision gate |
| `decorateCode` | `enrichment` | Only | Revision-matched line decoration; cannot change source, line topology or lifecycle |
| `setHTML` | `semantic` | Reserved only | `setHTML` carries `patchMeta`; explicit enrichment is reserved and currently not used by the worker |

Historical note (superseded): earlier versions of this ledger listed
`appendLines` as a semantic code-line fast path. That entry is retained only as
history, not as an active native-code contract. Native source-managed code uses
semantic changed-tail `appendCode` patches and decoration-only `decorateCode`
patches.

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

### `setProps` and `setPropsBatch`

Unmanaged generic nodes use reserved `props.range` and `props.meta` for canonical
authored ranges and metadata alongside content changes. Metadata omission retains
the current value, `null` clears it, and an object replaces the complete value.
Coalescing must preserve that replacement boundary rather than merge metadata keys.
Core and React consume both fields separately from presentation props and retain
historical cold values. Managed source owners still require their typed operations
and source guards.

`Patch.meta` remains the control envelope. A metadata payload does not change the
default semantic classification or expand the audited enrichment allowlist.

### `finalize`

`finalize` changes block lifecycle state and therefore visible semantics. It is
always semantic and epoch-guarded.


### `appendInputSource`

`appendInputSource` is a semantic root operation that retains bytes, not a
semantic child update or completion proof. Live `INITIALIZED` snapshots carry
the matching input generation and complete raw baseline, including an empty
baseline. Each later operation must target the root, match that generation, and
start at the consumer's current UTF-16 length before mutation.

Input operations remain ordered barriers. They are not coalesced or reordered,
and reverse `setProps` deduplication clears its seen-target set at each input
operation. Owner progress, ordinals, and envelope proofs remain independent.
Native owner `sourceAppend` values are separately validated against the root
document and contain exactly the newly owned authored suffix. An owner suffix
may include an LF admitted by an earlier root input operation. Root input
generation is independent of code, table, and paragraph owner generations.

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

For live consumers, accepted table views use immutable windows into one
root-owned input document, capped to each owner's `sourceRange`. They validate
the exact newly owned `sourceAppend` against that document before updating the
window. A suffix may include bytes, such as an LF, retained by an earlier root
append. Cold snapshots without a document baseline use honest per-block raw
slices and never reconstruct gaps between blocks. `processedTo` remains
monotonic across retraction and re-extension.

`closed` means the native table source prefix is committed while document input
may continue; it is distinct from worker `FINALIZED`. Dependency invalidation may
update affected row/header meaning on closed tables during live input and may
update source-identical rows/header after owner-source or document finalization
when generation, expected revision, and row source identity guards pass.
`appendTableRows` cannot grow or reopen a same-generation finalized table owner.


### `appendParagraph` and `updateParagraphSpans`

`appendParagraph` is always semantic, including metadata-only progress and a
closed-to-finalized lifecycle transition. Its required string `sourceAppend`
contains exactly the authored bytes newly entering the owner's source range,
never the full prefix. Metadata-only progress, source-neutral finalization, and
provisional-tail retraction carry an empty suffix. A span-changing append starts
at `completeSpanCount` and replaces only the provisional tail plus new spans;
metadata-only progress starts at the current `spanCount` and carries no spans.

The reducer checks paragraph owner ID, generation, expected and next revision,
source range, `processedTo`, complete-span frontier, span counts, and retained
source bytes before mutation. Re-extension must match any retained provisional
overlap. `closed` has no provisional span and can only finalize without source
growth; it is not worker `FINALIZED`. A same-generation finalized owner cannot
grow or reopen. Raw engine EOF growth may replace that owner under a fresh
generation.

`updateParagraphSpans` is also semantic, never enrichment. It changes only
dependency-affected prepared meaning and preserves the paragraph source,
span boundaries, and each updated span's source identity. Owner generation,
expected revision, consecutive next revision, and each `expectedSourceRevision`
guard the update. Same-source meaning updates remain valid on closed and
finalized owners, including after worker `FINALIZED`, while stale source or
ordering is rejected. Continued reference titles update dependent spans without
displacing the first definition.

The default public native paragraph append path does not run global
`getBlocks()` or document-wide MDX scans. A complete `Block` projection remains
explicit cold work; legacy custom paragraph props use that truthful full-source
path.

### `setProps`

`setProps` is semantic by default because it can replace full block payloads and
therefore meaning, ordering, or finalized state. It may be explicit enrichment
only when it updates already-correct decoration-only data.

Current audited enrichment uses:

- finalized lazy code highlighting metadata

Current audited semantic uses:

- native MDX source/ownership and semantic block transitions (not compile-status transitions)
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

Trusted compilation and evaluation readiness are outside the worker `Patch` union. The worker has no per-block `MDX_COMPILED` or `MDX_ERROR` transitions. A host may project an explicitly trusted whole-document revision after native finalization; this is not a patch-classification family.

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
