import assert from "node:assert";
import DOMPurifyFactory from "dompurify";
import type { Block, InlineNode, Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { createWorkerHarness } from "./worker-test-harness";

const SAMPLE_DOC = [
  "# Streaming Markdown Invariants",
  "",
  "This paragraph mixes *italic* text, ~~strike~~ formatting, and inline math $a + b = c$ to ensure inline parsing stabilizes.",
  "",
  "```ts",
  "export function square(value: number) {",
  "  return value * value;",
  "}",
  "```",
  "",
  "- First item with **bold** text",
  "- Second item with nested list:",
  "  - Inner child",
  "",
  "> Blockquote with `inline code`",
  "",
].join("\n");

const dompurifyShim = DOMPurifyFactory as unknown as { sanitize?: (html: string, config?: unknown) => string };
if (typeof dompurifyShim.sanitize !== "function") {
  dompurifyShim.sanitize = (html: string) => html;
}

function applyPatchMessages(store: ReturnType<typeof createRendererStore>, messages: WorkerOut[]): void {
  for (const msg of messages) {
    if (msg.type !== "PATCH") continue;
    store.applyPatches(msg.patches as Patch[], { captureMetrics: false });
  }
}

type NormalizedBlock = {
  type: string;
  isFinalized: boolean;
  raw: string | null;
  inlineKinds: string[];
  lineCount: number;
  metaSignature: string;
};

function collectInlineKinds(nodes: InlineNode[] | undefined, acc: string[]): void {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    acc.push(node.kind);
    if ("children" in node && Array.isArray((node as { children?: InlineNode[] }).children)) {
      collectInlineKinds((node as { children?: InlineNode[] }).children ?? [], acc);
    }
  }
}

function summarizeMeta(meta: Record<string, unknown> | undefined): string {
  if (!meta) return "";
  const parts: string[] = [];
  if (typeof meta.headingLevel === "number") {
    parts.push(`h${meta.headingLevel}`);
  }
  if (typeof meta.headingText === "string" && meta.headingText) {
    parts.push(`heading:${meta.headingText}`);
  }
  if (typeof meta.ordered === "boolean") {
    parts.push(`ordered:${meta.ordered}`);
  }
  if (Array.isArray(meta.items)) {
    parts.push(`items:${meta.items.length}`);
  }
  if (typeof meta.normalizedText === "string") {
    parts.push(`normalized:${meta.normalizedText}`);
  }
  if (typeof meta.inlineStatus === "string") {
    parts.push(`inline:${meta.inlineStatus}`);
  }
  return parts.join("|");
}

function cloneBlocks(blocks: ReadonlyArray<Block>): NormalizedBlock[] {
  return blocks.map((block) => {
    const inlineKinds: string[] = [];
    collectInlineKinds(block.payload?.inline as InlineNode[] | undefined, inlineKinds);
    const lineCount = Array.isArray(block.payload?.lines) ? block.payload!.lines!.length : 0;
    const normalized: NormalizedBlock = {
      type: block.type,
      isFinalized: block.isFinalized,
      raw: block.payload?.raw ?? null,
      inlineKinds,
      lineCount,
      metaSignature: summarizeMeta(block.payload?.meta as Record<string, unknown> | undefined),
    };
    return normalized;
  });
}

function assertStreamingInvariants(blocks: ReadonlyArray<Block>, label: string): void {
  const dirty = blocks.filter((block) => !block.isFinalized);
  assert.ok(dirty.length <= 1, `[${label}] expected at most one dirty block, found ${dirty.length}`);

  const duplicateParagraph = blocks.find(
    (block) => block.type === "paragraph" && typeof block.payload?.raw === "string" && block.payload.raw.includes("Handling missing values"),
  );
  assert.strictEqual(duplicateParagraph, undefined, `[${label}] duplicate list tails should not create standalone paragraphs`);

  const footnotes = blocks.filter((block) => block.type === "footnotes");
  assert.ok(footnotes.length <= 1, `[${label}] only one synthesized footnotes block expected`);
}

async function streamDocument(chunkSize: number): Promise<Block[]> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true },
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to emit INITIALIZED");
  store.reset(init.blocks);

  const doc = SAMPLE_DOC;
  for (let idx = 0; idx < doc.length; idx += chunkSize) {
    const segment = doc.slice(idx, idx + chunkSize);
    const appendMessages = await harness.send({ type: "APPEND", text: segment });
    const patches = appendMessages.filter((msg) => msg.type === "PATCH");
    assert.ok(patches.length > 0, `missing PATCH payload at segment ${idx / chunkSize}`);
    applyPatchMessages(store, appendMessages);
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  applyPatchMessages(store, finalizeMessages);

  const blocks = cloneBlocks(store.getBlocks());
  assertStreamingInvariants(blocks, `chunk=${chunkSize}`);
  return blocks;
}

async function runTickRateParity(): Promise<void> {
  const fineGrained = await streamDocument(80);
  const coarse = await streamDocument(400);
  assert.deepStrictEqual(
    coarse,
    fineGrained,
    "renderer snapshots should not depend on worker chunk size (tick rate)",
  );
}

await runTickRateParity();
console.log("Streaming tick-rate parity test passed");
