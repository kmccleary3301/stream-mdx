import assert from "node:assert";

import type { Patch, WorkerOut } from "@stream-mdx/core";
import { PATCH_ROOT_ID } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { JSDOM } from "jsdom";

import { createWorkerHarness } from "./worker-test-harness";

async function runNestedListCodeHighlightTest(): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
  (globalThis as any).Node = dom.window.Node;

  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: ["python"],
    docPlugins: { footnotes: false, html: false, mdx: false, tables: false, callouts: false },
  });
  const init = initMessages.find((m) => m.type === "INITIALIZED") as Extract<WorkerOut, { type: "INITIALIZED" }> | undefined;
  assert.ok(init, "worker did not emit INITIALIZED message");
  store.reset(init.blocks);

  const sentinel = 'print("nested-code-block-highlight")';
  const sample = ["*   ```python", `    ${sentinel}`, "    ```", ""].join("\n");

  const appendMessages = await harness.send({ type: "APPEND", text: sample });
  const appendPatches = appendMessages.filter((m): m is Extract<WorkerOut, { type: "PATCH" }> => m.type === "PATCH");
  for (const patchMsg of appendPatches) {
    store.applyPatches(patchMsg.patches as Patch[], { captureMetrics: false });
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  const finalizePatches = finalizeMessages.filter((m): m is Extract<WorkerOut, { type: "PATCH" }> => m.type === "PATCH");
  for (const patchMsg of finalizePatches) {
    store.applyPatches(patchMsg.patches as Patch[], { captureMetrics: false });
  }

  const stack = [...store.getChildren(PATCH_ROOT_ID)];
  let found: ReturnType<typeof store.getNode> | undefined;
  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (!nodeId) continue;
    const node = store.getNode(nodeId);
    if (!node) continue;
    if (node.type === "code" && typeof node.block?.payload?.raw === "string" && node.block.payload.raw.includes(sentinel)) {
      found = node;
      break;
    }
    const children = store.getChildren(nodeId);
    for (let idx = children.length - 1; idx >= 0; idx--) {
      stack.push(children[idx]);
    }
  }

  assert.ok(found, "expected list-nested code block node to exist");
  const highlightedHtml = found.block?.payload?.highlightedHtml;
  assert.ok(typeof highlightedHtml === "string" && highlightedHtml.includes("shiki"), "expected nested code block to be syntax highlighted");
}

await runNestedListCodeHighlightTest();
console.log("worker-nested-code-highlight test passed");
