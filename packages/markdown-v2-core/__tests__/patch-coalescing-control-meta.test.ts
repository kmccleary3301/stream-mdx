import assert from "node:assert";

import { applyPatchBatch, createInitialSnapshot } from "../src/block-snapshot";
import { PATCH_ROOT_ID, type Patch } from "../src/types";
import {
  DEFAULT_COALESCE_CONFIG,
  coalescePatchesLinear,
  coalescePatchesQuadratic,
} from "../src/perf/patch-coalescing";

function main(): void {
  const fencedPatches: Patch[] = [
    { op: "setProps", at: { blockId: "paragraph-1", nodeId: "paragraph-1" }, props: { beforeInput: true } },
    { op: "appendInputSource", at: { blockId: PATCH_ROOT_ID }, generation: 4, from: 0, text: "input" },
    { op: "setProps", at: { blockId: "paragraph-1", nodeId: "paragraph-1" }, props: { afterInput: true } },
  ];
  for (const coalesced of [
    coalescePatchesLinear(fencedPatches, DEFAULT_COALESCE_CONFIG),
    coalescePatchesQuadratic(fencedPatches, DEFAULT_COALESCE_CONFIG),
  ]) {
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
