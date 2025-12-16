import assert from "node:assert";
import type { InlineNode, Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { createWorkerHarness } from "./worker-test-harness";

function flattenInline(nodes: InlineNode[], kinds: Set<string>, texts: string[]): void {
  for (const node of nodes) {
    if (node.kind === "text") {
      texts.push(node.text);
      continue;
    }
    kinds.add(node.kind);
    if ("children" in node && Array.isArray((node as { children?: InlineNode[] }).children)) {
      flattenInline(((node as { children?: InlineNode[] }).children ?? []) as InlineNode[], kinds, texts);
    }
  }
}

async function runStreamingInlineStability(): Promise<void> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true },
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker did not emit INITIALIZED");
  store.reset(init.blocks);

  const chunks = ["This is *italic", " text* and ~~strike", "~~ done"];
  for (const chunk of chunks) {
    const appendMessages = await harness.send({ type: "APPEND", text: chunk });
    const patchMessages = appendMessages.filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH");
    assert.ok(patchMessages.length > 0, "expected PATCH response from append");
    for (const msg of patchMessages) {
      store.applyPatches(msg.patches as Patch[], { captureMetrics: false });
    }
  }

  const blocks = [...store.getBlocks()];
  const paragraph = blocks.find((block) => block.type === "paragraph" && block.payload?.raw.includes("italic"));
  assert.ok(paragraph, "expected streamed paragraph block");
  assert.notStrictEqual(paragraph.payload?.meta?.inlineStatus, "partial", "inline status must finalize after streaming completes");

  const inlineNodes: InlineNode[] = Array.isArray(paragraph.payload?.inline) ? (paragraph.payload?.inline as InlineNode[]) : [];
  const kinds = new Set<string>();
  const texts: string[] = [];
  flattenInline(inlineNodes, kinds, texts);

  assert(kinds.has("em"), "missing emphasis node in inline output");
  assert(kinds.has("strike"), "missing strikethrough node in inline output");
  assert(
    texts.every((text) => !text.includes("~~") && !text.includes("*")),
    `raw delimiters leaked into inline nodes: ${texts.join(" | ")}`,
  );
}

await runStreamingInlineStability();
console.log("Streaming inline stability test passed");
