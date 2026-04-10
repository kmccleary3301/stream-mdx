# Post-Finalize Mutation Ledger

This ledger is the explicit allowlist for visible mutations that may occur after the worker emits `FINALIZED`.

If a post-finalize visible mutation path is not listed here, it is a bug until proven otherwise.

## Contract

After `FINALIZED`, blocks are semantically stable. The only allowed follow-up mutations are:

| Path | Source | Patch kind | Allowed? | Why |
| --- | --- | --- | --- | --- |
| Lazy code tokenization metadata and line HTML/tokens | Worker `TOKENIZE_RANGE` follow-up on finalized code blocks | `enrichment` | Yes | Completes deferred syntax coloring for an already-finalized code block without changing block topology or semantic block identity |
| MDX compiled status/ref application | Worker `MDX_COMPILED` routed through `handleMdxStatus` | `semantic` | Yes | Makes the finalized MDX block transition from pending to compiled; this is a visible semantic state change and must stay epoch-guarded |
| MDX error status/message application | Worker `MDX_ERROR` routed through `handleMdxStatus` | `semantic` | Yes | Makes the finalized MDX block transition from pending to error; this is also a visible semantic state change and must stay epoch-guarded |

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

## Disallowed Post-Finalize Mutations

These are not allowed after `FINALIZED` unless they arrive under a newer semantic epoch:

- structural list/table/code child topology changes
- block type changes
- delayed semantic reparses for finalized non-MDX blocks
- deferred patch queue replays from the pre-finalize parse
- semantic mutations with stale `blockEpoch`

These are guarded by:

- stale epoch rejection in `packages/markdown-v2-react/src/renderer/store.ts`
- deferred queue clearing on append/finalize in `packages/markdown-v2-worker/src/worker.ts`
- direct boundary tests listed above
