import assert from "node:assert";
import type { InlineNode, Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { createWorkerHarness } from "./worker-test-harness";

function inlineKinds(nodes: InlineNode[]): string[] {
  const kinds: string[] = [];
  const walk = (items: InlineNode[]) => {
    for (const node of items) {
      kinds.push(node.kind);
      if ("children" in node && Array.isArray((node as { children?: InlineNode[] }).children)) {
        walk((node as { children?: InlineNode[] }).children ?? []);
      }
    }
  };
  walk(nodes);
  return kinds;
}

async function collectBlocks(docPlugins: { html?: boolean; mdx?: boolean; math?: boolean }): Promise<InlineNode[]> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins,
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker did not emit INITIALIZED");
  store.reset(init.blocks);

  const sample = [
    "Inline math $a+b=c$ and display:\n",
    "$$x^2 + y^2 = z^2$$\n",
    "<div data-prop=\"html\">unsafe</div>\n",
  ].join("");

  const appendMessages = await harness.send({ type: "APPEND", text: sample });
  appendMessages
    .filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH")
    .forEach((msg) => store.applyPatches(msg.patches as Patch[], { captureMetrics: false }));

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  finalizeMessages
    .filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH")
    .forEach((msg) => store.applyPatches(msg.patches as Patch[], { captureMetrics: false }));

  const blocks = store.getBlocks();
  const paragraph = blocks.find((block) => block.type === "paragraph");
  assert.ok(paragraph, "expected paragraph block");
  return Array.isArray(paragraph.payload?.inline) ? (paragraph.payload?.inline as InlineNode[]) : [];
}

async function testMathDisabled(): Promise<void> {
  const inlines = await collectBlocks({ math: false, html: true });
  const kinds = inlineKinds(inlines);
  assert.ok(!kinds.includes("math-inline"), "math-inline should be disabled when math flag is false");
  assert.ok(!kinds.includes("math-display"), "math-display should be disabled when math flag is false");
}

async function testHtmlDisabled(): Promise<void> {
  const inlines = await collectBlocks({ html: false, math: true });
  const kinds = inlineKinds(inlines);
  const containsHtml = kinds.some((kind) => kind === "html");
  assert.strictEqual(containsHtml, false, "html plugin disabled should treat html as text");
}

await testMathDisabled();
await testHtmlDisabled();
console.log("Worker plugin toggle tests passed");
