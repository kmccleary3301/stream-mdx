import assert from "node:assert";

import { PATCH_ROOT_ID, type Block, type Patch } from "@stream-mdx/core";

import { createRendererStore } from "../src/renderer/store";

function createParagraphBlock(raw: string): Block {
  return {
    id: "paragraph-block",
    type: "paragraph",
    isFinalized: false,
    payload: {
      raw,
    },
  };
}

async function main() {
  const store = createRendererStore([createParagraphBlock("alpha")]);

  const initial = store.getNode("paragraph-block");
  assert.ok(initial, "expected paragraph block node to exist");
  const staleEpoch = initial.blockEpoch;

  store.applyPatches([
    {
      op: "setProps",
      at: { blockId: "paragraph-block", nodeId: "paragraph-block" },
      props: {
        block: createParagraphBlock("beta"),
      },
    } satisfies Patch,
  ]);

  const replaced = store.getNode("paragraph-block");
  assert.ok(replaced, "expected paragraph block node after semantic replacement");
  assert.ok(replaced.blockEpoch > staleEpoch, "semantic block replacement should advance block epoch");
  assert.strictEqual(replaced.block?.payload.raw, "beta", "expected semantic replacement to update block payload");

  store.applyPatches([
    {
      op: "setProps",
      at: { blockId: "paragraph-block", nodeId: "paragraph-block" },
      props: {
        staleMarker: "should-not-land",
      },
      meta: {
        kind: "semantic",
        blockEpoch: staleEpoch,
      },
    } satisfies Patch,
  ]);

  const afterRejected = store.getNode("paragraph-block");
  assert.ok(afterRejected, "expected paragraph block node after stale rejection");
  assert.strictEqual(
    afterRejected.props?.staleMarker,
    undefined,
    "stale semantic patch should be rejected without mutating target props",
  );

  const counters = store.getDebugCounters();
  assert.strictEqual(counters.staleEpochRejected, 1, "expected stale epoch rejection counter to increment");

  const violations = store.getInvariantViolations();
  assert.ok(
    violations.some((message) => message.includes("stale epoch rejected:setProps:paragraph-block")),
    "expected stale epoch rejection to be recorded in diagnostics",
  );

  store.applyPatches([
    {
      op: "insertChild",
      at: { blockId: PATCH_ROOT_ID },
      index: 1,
      node: {
        id: "footnote-block",
        type: "footnotes",
        props: {},
        children: [],
        meta: {
          blockEpoch: 7,
        },
      },
      meta: {
        kind: "semantic",
        blockEpoch: 7,
      },
    } satisfies Patch,
  ]);

  const inserted = store.getNode("footnote-block");
  assert.ok(inserted, "root insertChild patches should not be stale-rejected against the synthetic root epoch");
  assert.strictEqual(
    store.getDebugCounters().staleEpochRejected,
    1,
    "root insertChild should not increment stale epoch rejection count",
  );
}

await main();
console.log("stale-epoch-guard test passed");
