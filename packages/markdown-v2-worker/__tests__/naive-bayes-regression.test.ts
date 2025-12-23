import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";

import type { Block, InlineNode, Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { JSDOM } from "jsdom";

import { createWorkerHarness } from "./worker-test-harness";

function ensureDom() {
  if (typeof (globalThis as any).window !== "undefined") {
    return;
  }

  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
  (globalThis as any).Node = dom.window.Node;
}

function flattenInline(nodes: InlineNode[], out: InlineNode[]): void {
  for (const node of nodes) {
    out.push(node);
    if ("children" in node && Array.isArray(node.children)) {
      flattenInline(node.children, out);
    }
  }
}

function collectInlineText(blocks: ReadonlyArray<Block>): string[] {
  const texts: string[] = [];
  for (const block of blocks) {
    if (!Array.isArray(block.payload?.inline)) continue;
    const flat: InlineNode[] = [];
    flattenInline(block.payload.inline as InlineNode[], flat);
    for (const node of flat) {
      if (node.kind === "text") {
        texts.push(node.text);
      }
    }
  }
  return texts;
}

function collectPayloadStrings(blocks: ReadonlyArray<Block>): string {
  const strings: string[] = [];
  const seen = new Set<unknown>();

  const collect = (value: unknown): void => {
    if (!value) return;
    if (typeof value === "string") {
      strings.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry);
      return;
    }
    if (typeof value === "object") {
      if (seen.has(value)) return;
      seen.add(value);
      for (const entry of Object.values(value as Record<string, unknown>)) collect(entry);
    }
  };

  for (const block of blocks) {
    strings.push(block.payload?.raw ?? "");
    const payload = block.payload as unknown as Record<string, unknown>;
    const meta = payload?.meta as unknown;
    const lines = payload?.lines as unknown;
    collect(meta);
    collect(lines);
  }

  return strings.join("\n");
}

function applyPatchMessages(store: ReturnType<typeof createRendererStore>, messages: WorkerOut[]): void {
  for (const msg of messages) {
    if (msg.type !== "PATCH") continue;
    store.applyPatches(msg.patches as Patch[], { captureMetrics: false });
  }
}

async function streamFixture(chunkSize: number): Promise<Block[]> {
  ensureDom();

  const fixturePath = path.resolve(process.cwd(), "../../apps/docs/app/demo/naive-bayes-classifier.mdx");
  const doc = await fs.readFile(fixturePath, "utf8");

  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true, math: true, formatAnticipation: true },
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to emit INITIALIZED");
  store.reset(init.blocks);

  for (let idx = 0; idx < doc.length; idx += chunkSize) {
    const chunk = doc.slice(idx, idx + chunkSize);
    const messages = await harness.send({ type: "APPEND", text: chunk });
    applyPatchMessages(store, messages);
  }

  const finalize = await harness.send({ type: "FINALIZE" });
  applyPatchMessages(store, finalize);

  return store.getBlocks();
}

function assertFixtureInvariants(blocks: ReadonlyArray<Block>, label: string): void {
  const rawJoined = collectPayloadStrings(blocks);

  assert.ok(rawJoined.includes("Westport, Connecticut"), `[${label}] expected hedge fund table cell to be present`);
  assert.ok(rawJoined.includes("Append <kbd>`{:lang}{:js}`</kbd>"), `[${label}] expected inline code/kbd sentence to be present`);
  assert.ok(rawJoined.includes("| First Header  | Second Header |"), `[${label}] expected tail table code fence to be present`);

  const footnotes = blocks.filter((block) => block.type === "footnotes");
  assert.strictEqual(footnotes.length, 1, `[${label}] expected exactly one synthesized footnotes block after FINALIZE`);

  const inlineTexts = collectInlineText(blocks);
  const strayMath = inlineTexts.filter((text) => text.includes("$") && (text.includes("R_{") || text.includes("\\Gamma") || text.includes("g_{")));
  assert.strictEqual(strayMath.length, 0, `[${label}] expected no raw math delimiters in inline text nodes`);

  const longPrint = 'print("this is a really really really really really really really really really really really really really really really really really really really really really long inline code block")';
  const printCount = rawJoined.split(longPrint).length - 1;
  assert.ok(printCount >= 2, `[${label}] expected both long python print code blocks to be present`);
}

async function run(): Promise<void> {
  for (const chunkSize of [64, 256]) {
    const blocks = await streamFixture(chunkSize);
    assertFixtureInvariants(blocks, `chunk=${chunkSize}`);
  }
}

await run();
console.log("naive-bayes streaming regression test passed");
