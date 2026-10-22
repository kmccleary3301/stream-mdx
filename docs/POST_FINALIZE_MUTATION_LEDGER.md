# Post-Finalize Mutation Ledger

This ledger is the explicit allowlist for visible mutations that may occur after the worker emits `FINALIZED`.

If a post-finalize visible mutation path is not listed here, it is a bug until proven otherwise.

## Contract

After `FINALIZED`, native blocks are semantically stable. The only allowed follow-up worker patch is:

| Path | Source | Patch kind | Allowed? | Why |
| --- | --- | --- | --- | --- |
| Lazy code tokenization metadata and line HTML/tokens | Worker `TOKENIZE_RANGE` follow-up on finalized code blocks | `enrichment` | Yes | Completes deferred syntax coloring for an already-finalized code block without changing block topology or semantic block identity |

All other worker-visible block mutations are disallowed unless they arrive under a newer parse epoch / semantic transaction. Trusted whole-document readiness is separate host-owned render state, not a worker mutation or exception to this allowlist.

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


## Disallowed Post-Finalize Mutations

These are not allowed after `FINALIZED` unless they arrive under a newer semantic epoch:

- structural list/table/code child topology changes
- block type changes
- delayed semantic reparses of finalized blocks, including legacy per-block MDX compile/error status updates
- deferred patch queue replays from the pre-finalize parse
- semantic mutations with stale `blockEpoch`
- per-block `MDX_COMPILED` or `MDX_ERROR` worker messages; these are not part of the current worker protocol

These are guarded by:

- stale epoch rejection in `packages/markdown-v2-react/src/renderer/store.ts`
- deferred queue clearing on append/finalize in `packages/markdown-v2-worker/src/worker.ts`
- direct boundary tests listed above
- `packages/markdown-v2-react/__tests__/finalized-semantic-stability.test.ts`
- `packages/markdown-v2-react/__tests__/post-finalize-contract.test.ts`
