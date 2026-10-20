import assert from "node:assert";

import { applyPatchBatch, createInitialSnapshot } from "../src/block-snapshot";
import { PATCH_ROOT_ID, type Patch } from "../src/types";
import {
  DEFAULT_COALESCE_CONFIG,
  coalescePatchesLinear,
  coalescePatchesQuadratic,
  coalescePatchesWithMetrics,
} from "../src/perf/patch-coalescing";

function main(): void {
  const patches: Patch[] = [
    {
      op: "setProps",
      at: { blockId: "list-1", nodeId: "list-1" },
      props: { block: { id: "list-1", type: "list", isFinalized: false, payload: { raw: "1. First" } } },
      meta: { kind: "semantic", parseEpoch: 20, tx: 20, blockEpoch: 19 },
    },
    {
      op: "setProps",
      at: { blockId: "list-1", nodeId: "list-1::item:0" },
      props: { text: "First" },
      meta: { kind: "semantic", parseEpoch: 20, tx: 20, blockEpoch: 19 },
    },
  ];

  const result = coalescePatchesWithMetrics(patches, DEFAULT_COALESCE_CONFIG);
  assert.strictEqual(result.patches.length, 1, "expected adjacent setProps patches to coalesce into one batch");

  const batch = result.patches[0];
  assert.ok(batch && batch.op === "setPropsBatch", "expected coalesced patch to be setPropsBatch");

  const entries = batch.entries ?? [];
  assert.strictEqual(entries.length, 2, "expected both setProps entries in batch");
  assert.deepStrictEqual(entries[0]?.meta, patches[0]?.meta, "expected first entry control meta to be preserved");
  assert.deepStrictEqual(entries[1]?.meta, patches[1]?.meta, "expected second entry control meta to be preserved");
  const fencedPatches: Patch[] = [
    { op: "setProps", at: { blockId: "paragraph-1", nodeId: "paragraph-1" }, props: { beforeInput: true } },
    { op: "appendInputSource", at: { blockId: PATCH_ROOT_ID }, generation: 4, from: 0, text: "input" },
    { op: "setProps", at: { blockId: "paragraph-1", nodeId: "paragraph-1" }, props: { afterInput: true } },
  ];
  for (const coalesced of [
    coalescePatchesLinear(fencedPatches, DEFAULT_COALESCE_CONFIG),
    coalescePatchesQuadratic(fencedPatches, DEFAULT_COALESCE_CONFIG),
  ]) {
    assert.deepStrictEqual(
      coalesced.map((patch) => patch.op),
      ["setProps", "appendInputSource", "setProps"],
      "input appends preserve order and fence reverse setProps deduplication",
    );
    const snapshot = createInitialSnapshot({
      id: PATCH_ROOT_ID,
      type: "__root__",
      inputSource: { generation: 4, raw: "" },
      children: [{ id: "paragraph-1", type: "paragraph", props: {}, children: [] }],
    });
    applyPatchBatch(snapshot, coalesced);
    const props = snapshot.nodes.get("paragraph-1")?.props;
    assert.strictEqual(props?.beforeInput, true, "the semantic target keeps properties before input retention");
    assert.strictEqual(props?.afterInput, true, "the semantic target keeps properties after input retention");
  }
}

main();
console.log("patch-coalescing-control-meta test passed");
