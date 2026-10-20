# Post-Finalize Mutation Ledger

_Last updated: 2026-10-19_

If a post-finalize visible mutation path is not listed here, it is a bug until proven otherwise.

## Contract

After worker `FINALIZED`, existing committed owner source windows and block
topology stay fixed. A newer semantic input transaction may append to the
canonical root document without widening those windows; any resumed raw-EOF
owner uses its own fresh generation.

| Path | Source | Patch kind | Allowed? | Why |
| --- | --- | --- | --- | --- |
| Lazy code tokenization metadata and line HTML/tokens | Worker `TOKENIZE_RANGE` follow-up on finalized code blocks | `enrichment` | Yes | Completes deferred syntax coloring for an already-finalized code block without changing block topology or semantic block identity |
| MDX compiled status/ref application | Worker `MDX_COMPILED` routed through `handleMdxStatus` | `semantic` | Yes | Makes the finalized MDX block transition from pending to compiled; this is a visible semantic state change and must stay epoch-guarded |
| MDX error status/message application | Worker `MDX_ERROR` routed through `handleMdxStatus` | `semantic` | Yes | Makes the finalized MDX block transition from pending to error; this is also a visible semantic state change and must stay epoch-guarded |
| Paragraph dependency meaning | Worker `updateParagraphSpans` for link, footnote, or numbering invalidation | `semantic` | Yes | Changes only affected prepared spans whose owner generation, expected revision, span source revision, and source identity still match |
| Table dependency meaning | Worker `updateTableRows` for reference, footnote, or numbering invalidation | `semantic` | Yes | Changes only affected row/header meaning while preserving table source identity under owner generation, expected revision, and row source identity guards |
| Canonical root input retention | Worker `APPEND` admitted after EOF | `semantic` | Yes | Extends only the root input document; it does not mutate a finalized owner or count as owner progress |

All semantic entries remain subject to epoch and transaction ordering and stale
patch rejection. The paragraph and table entries cannot append source, change
span/row boundaries, or reopen finalized owners.

Everything else is disallowed unless it happens under a newer parse epoch / semantic transaction.

## Classification Details

### 1. Lazy code tokenization

- Worker entry: `packages/markdown-v2-worker/src/worker.ts` (`TOKENIZE_RANGE`)
- Worker emission path: `packages/markdown-v2-worker/src/worker.ts` (`dispatchPatchBatch(withPatchKindBatch(..., "enrichment"))`)
- Renderer consumption path: `packages/markdown-v2-react/src/renderer/node-views.tsx` (`reason: "finalize-full"`)

Properties:

- Allowed only for code blocks that are already finalized.
- Must emit `enrichment` patches only.
- Must not re-emit `finalize`.
- Must not advance block epoch.
- Must not reopen finalized blocks.

Guard coverage:

- `packages/markdown-v2-worker/__tests__/worker-post-finalize-boundary.test.ts`
- `packages/markdown-v2-react/__tests__/post-finalize-store-boundary.test.ts`
- `packages/markdown-v2-react/__tests__/finalized-semantic-stability.test.ts`
- `packages/markdown-v2-react/__tests__/post-finalize-contract.test.ts`

### 2. MDX compiled transition

- Worker message entry: `packages/markdown-v2-worker/src/worker.ts` (`MDX_COMPILED`)
- Worker mutation path: `packages/markdown-v2-worker/src/worker.ts` (`handleMdxStatus`)
- Coordinator source: `packages/markdown-v2-react/src/mdx-coordinator.ts`

Properties:

- Allowed only when the response raw signature matches the current finalized MDX raw content.
- Must remain `semantic`.
- Must be rejected when stale.
- Must advance block epoch when accepted.
- Must not reopen finalized blocks.

Guard coverage:

- `packages/markdown-v2-worker/__tests__/worker-post-finalize-boundary.test.ts`
- `packages/markdown-v2-worker/__tests__/worker-mdx-status-signature-guard.test.ts`
- `packages/markdown-v2-react/__tests__/post-finalize-store-boundary.test.ts`
- `packages/markdown-v2-react/__tests__/finalized-semantic-stability.test.ts`
- `packages/markdown-v2-react/__tests__/post-finalize-contract.test.ts`

### 3. MDX error transition

- Worker message entry: `packages/markdown-v2-worker/src/worker.ts` (`MDX_ERROR`)
- Worker mutation path: `packages/markdown-v2-worker/src/worker.ts` (`handleMdxStatus`)
- Coordinator source: `packages/markdown-v2-react/src/mdx-coordinator.ts`

Properties:

- Allowed only when the response raw signature matches the current finalized MDX raw content.
- Must remain `semantic`.
- Must be rejected when stale.
- Must advance block epoch when accepted.
- Must not reopen finalized blocks.

Guard coverage:

- `packages/markdown-v2-worker/__tests__/worker-post-finalize-boundary.test.ts`
- `packages/markdown-v2-worker/__tests__/worker-mdx-status-signature-guard.test.ts`
- `packages/markdown-v2-react/__tests__/post-finalize-store-boundary.test.ts`
- `packages/markdown-v2-react/__tests__/finalized-semantic-stability.test.ts`
- `packages/markdown-v2-react/__tests__/post-finalize-contract.test.ts`

## Source-Neutral Native Updates

A table in `closed` state has a committed native source prefix while document
input may continue. This is paragraph/table owner state, not worker
`FINALIZED`. `updateTableRows` may change dependency-affected meaning on a closed
or finalized table, including after worker `FINALIZED`, only when owner
generation, expected revision, and row/header source identities match. It never
appends table source.

`updateParagraphSpans` follows the same source-neutral rule for closed or
finalized paragraph owners. It updates only dependency-affected prepared spans
whose source revision and source identity still match, and preserves the
paragraph's authored bytes and span boundaries.

`appendTableRows` and `appendParagraph` cannot grow or reopen same-generation
finalized source owners. Raw input accepted after EOF may extend the independent
root input generation, but the engine replaces an affected owner under a fresh
owner generation instead of reopening its finalized source window.

## Disallowed Post-Finalize Mutations

These are not allowed after `FINALIZED` unless they arrive under a newer semantic epoch:

- structural list/table/code child topology changes
- block type changes
- delayed semantic reparses for finalized non-MDX blocks
- deferred patch queue replays from the pre-finalize parse
- semantic mutations with stale `blockEpoch`
- stale semantic code-line updates, list reorders, or table replacements against finalized blocks

These are guarded by:

- stale epoch rejection in `packages/markdown-v2-react/src/renderer/store.ts`
- deferred queue clearing on append/finalize in `packages/markdown-v2-worker/src/worker.ts`
- direct boundary tests listed above
- `packages/markdown-v2-react/__tests__/finalized-semantic-stability.test.ts`
- `packages/markdown-v2-react/__tests__/post-finalize-contract.test.ts`
