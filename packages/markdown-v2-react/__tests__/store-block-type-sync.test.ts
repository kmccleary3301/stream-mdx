import assert from "node:assert";

import type { Block, Patch } from "@stream-mdx/core";

import { createRendererStore } from "../src/renderer/store";

function htmlBlock(id: string): Block {
  return {
    id,
    type: "html",
    isFinalized: true,
    payload: {
      raw: "<Preview />",
      sanitizedHtml: "<preview></preview>",
      meta: {},
    },
  };
}

function mdxBlock(id: string): Block {
  return {
    id,
    type: "mdx",
    isFinalized: true,
    payload: {
      raw: "<Preview />",
      meta: { originalType: "html", mdxStatus: "pending" },
    },
  };
}

async function runStoreBlockTypeSyncTest(): Promise<void> {
  const id = "type-sync-block";
  const store = createRendererStore([htmlBlock(id)]);

  const before = store.getNode(id);
  assert.strictEqual(before?.type, "html", "expected initial html node type");

  const patch: Patch = {
    op: "setProps",
    at: { blockId: id },
    props: {
      block: mdxBlock(id),
    },
  };

  store.applyPatches([patch], { captureMetrics: false });

  const after = store.getNode(id);
  assert.ok(after, "expected updated node");
  assert.strictEqual(after?.type, "mdx", "node type should track incoming block type");
  assert.strictEqual(after?.block?.type, "mdx", "stored block should be mdx");
}

await runStoreBlockTypeSyncTest();
console.log("store block type sync test passed");
