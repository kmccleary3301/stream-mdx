import assert from "node:assert";
import { JSDOM } from "jsdom";

import { PATCH_ROOT_ID, type InlineNode, type Patch, type WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";

import { createWorkerHarness } from "./worker-test-harness";

function ensureDom(): void {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
    return;
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
  (globalThis as any).Node = dom.window.Node;
}

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

function applyPatchMessages(store: ReturnType<typeof createRendererStore>, messages: WorkerOut[]): void {
  for (const msg of messages) {
    if (msg.type !== "PATCH") continue;
    store.applyPatches(msg.patches as Patch[], { captureMetrics: false });
  }
}

function findListItemInlineByText(store: ReturnType<typeof createRendererStore>, needle: string): InlineNode[] {
  const stack: string[] = [PATCH_ROOT_ID];
  const seen = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);

    const children = store.getChildren(current);
    for (const childId of children) {
      const child = store.getNode(childId);
      if (!child) continue;
      stack.push(childId);

      if (child.type !== "list-item") {
        continue;
      }

      const inline = Array.isArray(child.props?.inline) ? ((child.props?.inline ?? []) as InlineNode[]) : [];
      const texts: string[] = [];
      flattenInline(inline, new Set<string>(), texts);
      if (texts.join(" ").includes(needle)) {
        return inline;
      }
    }
  }

  return [];
}

async function runListAnticipationTest(): Promise<void> {
  ensureDom();

  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: {
      footnotes: true,
      html: true,
      mdx: true,
      tables: true,
      callouts: true,
      math: true,
      formatAnticipation: true,
    },
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker did not emit INITIALIZED");
  store.reset(init.blocks);

  const partialNestedList = ["1. Root item", "   - **Handling missing values in nested list emphasis"].join("\n");
  const appendMessages = await harness.send({ type: "APPEND", text: partialNestedList });
  applyPatchMessages(store, appendMessages);

  const blocks = [...store.getBlocks()];
  const listBlock = blocks.find((block) => block.type === "list");
  assert.ok(listBlock, "expected streamed list block");

  const targetText = "Handling missing values in nested list emphasis";
  let inline: InlineNode[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    inline = findListItemInlineByText(store, targetText);
    const attemptKinds = new Set<string>();
    const attemptTexts: string[] = [];
    flattenInline(inline, attemptKinds, attemptTexts);
    if (attemptKinds.has("strong")) {
      break;
    }
    const flushMessages = await harness.send({ type: "SET_CREDITS", credits: 1 });
    applyPatchMessages(store, flushMessages);
  }

  assert.ok(inline.length > 0, `expected nested list-item inline content containing \"${targetText}\"`);

  const kinds = new Set<string>();
  const texts: string[] = [];
  flattenInline(inline, kinds, texts);

  assert(kinds.has("strong"), "expected list-item anticipation to emit strong node for incomplete '**' segment");
  assert(
    texts.every((text) => !text.includes("**")),
    `expected no raw '**' delimiters in anticipated list-item inline text, got: ${texts.join(" | ")}`,
  );
}

await runListAnticipationTest();
console.log("list-item format anticipation test passed");
