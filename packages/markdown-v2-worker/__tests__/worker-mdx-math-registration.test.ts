import assert from "node:assert";
import type { Block, InlineNode, Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import { createWorkerHarness } from "./worker-test-harness";

const SAMPLE_SNIPPET = [
  "Inline math $a^2 + b^2 = c^2$ lives next to an embedded MDX component:",
  "",
  '<Callout tone="info">Remember that $$E=mc^2$$ holds even inside MDX.</Callout>',
].join("\n");

function containsMathNodes(nodes: InlineNode[] | undefined): boolean {
  if (!nodes || nodes.length === 0) return false;
  for (const node of nodes) {
    if (node.kind === "math-inline" || node.kind === "math-display") {
      return true;
    }
    if ("children" in node && Array.isArray((node as { children?: InlineNode[] }).children)) {
      if (containsMathNodes((node as { children?: InlineNode[] }).children ?? [])) {
        return true;
      }
    }
  }
  return false;
}

async function renderSnippetWithPlugins(): Promise<Block[]> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { html: true, mdx: true, math: true, tables: true, callouts: true },
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker did not initialize before streaming snippet");
  store.reset(init.blocks);

  const appendMessages = await harness.send({ type: "APPEND", text: SAMPLE_SNIPPET });
  appendMessages
    .filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH")
    .forEach((msg) => store.applyPatches(msg.patches as Patch[], { captureMetrics: false }));

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  finalizeMessages
    .filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH")
    .forEach((msg) => store.applyPatches(msg.patches as Patch[], { captureMetrics: false }));

  return store.getBlocks();
}

async function main() {
  const blocks = await renderSnippetWithPlugins();
  const mdxBlock = blocks.find((block) => block.type === "mdx");
  assert.ok(mdxBlock, "expected MDX detection plugin to retag Callout block to type 'mdx'");

  const mathParagraph = blocks.find((block) => block.type === "paragraph" && typeof block.payload.raw === "string" && block.payload.raw.includes("$a^2"));
  assert.ok(mathParagraph, "expected inline paragraph to survive next to MDX");
  assert.ok(containsMathNodes(mathParagraph.payload.inline), "paragraph inline nodes should include math markers when math plugin is enabled");

  console.log("worker mdx/math registration test passed");
}

await main();
