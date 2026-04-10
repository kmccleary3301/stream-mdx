import assert from "node:assert";
import fs from "node:fs/promises";

import { applyPatchBatch, createInitialSnapshot, type Block, type Patch, type WorkerOut } from "@stream-mdx/core";
import DOMPurifyFactory from "dompurify";
import { createRendererStore } from "@stream-mdx/react/renderer/store";

import { createWorkerHarness } from "./worker-test-harness";

const DOC_PLUGINS = {
  footnotes: true,
  html: true,
  mdx: true,
  tables: true,
  callouts: true,
  math: true,
} as const;

const dompurifyShim = DOMPurifyFactory as unknown as { sanitize?: (html: string, config?: unknown) => string };
if (typeof dompurifyShim.sanitize !== "function") {
  dompurifyShim.sanitize = (html: string) => html;
}

async function loadFixture(name: string): Promise<string> {
  return await fs.readFile(new URL(`../../../tests/regression/fixtures/${name}`, import.meta.url), "utf8");
}

function applyPatchMessages(store: ReturnType<typeof createRendererStore>, messages: WorkerOut[]): void {
  for (const message of messages) {
    if (message.type !== "PATCH") continue;
    store.applyPatches(message.patches as Patch[], { captureMetrics: false });
  }
}

async function streamFixture(
  content: string,
  chunkSize: number,
  options: { mdxCompileMode?: "server" | "worker" } = {},
): Promise<Block[]> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: DOC_PLUGINS,
    mdx: options.mdxCompileMode ? { compileMode: options.mdxCompileMode } : undefined,
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to initialize");
  store.reset(init.blocks);

  for (let index = 0; index < content.length; index += chunkSize) {
    const chunk = content.slice(index, index + chunkSize);
    const appendMessages = await harness.send({ type: "APPEND", text: chunk });
    applyPatchMessages(store, appendMessages);
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  applyPatchMessages(store, finalizeMessages);
  return store.getBlocks();
}

async function runAppendLinesTailGuardTest(): Promise<void> {
  const content = await loadFixture("code-huge.md");
  const harness = await createWorkerHarness();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: DOC_PLUGINS,
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to initialize");

  const snapshot = createInitialSnapshot(init.blocks);
  let appendLinesCount = 0;

  const applyMessages = (messages: WorkerOut[]) => {
    for (const message of messages) {
      if (message.type !== "PATCH") continue;
      for (const patch of message.patches as Patch[]) {
        if (patch.op === "appendLines") {
          const parentId = patch.at.nodeId ?? patch.at.blockId;
          const parent = snapshot.nodes.get(parentId);
          assert.ok(parent, `missing code parent for appendLines: ${parentId}`);
          assert.strictEqual(parent?.type, "code", "appendLines target must remain a code node");
          assert.strictEqual(patch.startIndex, parent?.children.length ?? -1, "appendLines must be a strict tail append");
          appendLinesCount += 1;
        }
        snapshot.blocks = applyPatchBatch(snapshot, [patch]);
      }
    }
  };

  for (let index = 0; index < content.length; index += 37) {
    const appendMessages = await harness.send({ type: "APPEND", text: content.slice(index, index + 37) });
    applyMessages(appendMessages);
  }

  applyMessages(await harness.send({ type: "FINALIZE" }));
  assert.ok(appendLinesCount > 0, "expected appendLines patches to be emitted for streaming code");
}

async function runFinalizedTableShapeTest(): Promise<void> {
  const blocks = await streamFixture(await loadFixture("table-boundary.md"), 29);
  const table = blocks.find((block) => block.type === "table");
  assert.ok(table, "expected finalized table block");
  const meta = (table?.payload.meta ?? {}) as { header?: unknown[][]; rows?: unknown[][][] };
  const headerColumns = Array.isArray(meta.header) ? meta.header.length : 0;
  assert.ok(headerColumns > 0, "expected table header columns");
  const rows = Array.isArray(meta.rows) ? meta.rows : [];
  assert.ok(rows.length > 0, "expected finalized table body rows");
  rows.forEach((row, rowIndex) => {
    assert.strictEqual(row.length, headerColumns, `finalized table row ${rowIndex} width mismatch`);
  });
}

async function runStreamingTableDeferralTest(): Promise<void> {
  const content = await loadFixture("table-boundary.md");
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: DOC_PLUGINS,
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to initialize");
  store.reset(init.blocks);

  for (let index = 0; index < content.length; index += 29) {
    const appendMessages = await harness.send({ type: "APPEND", text: content.slice(index, index + 29) });
    applyPatchMessages(store, appendMessages);
    const partialTable = store.getBlocks().find((block) => block.type === "table" && !block.isFinalized);
    assert.ok(!partialTable, "table blocks must not materialize while still streaming");
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  applyPatchMessages(store, finalizeMessages);
  assert.ok(store.getBlocks().some((block) => block.type === "table"), "expected table block after finalization");
}

function hasMathInline(nodes: unknown): boolean {
  if (!Array.isArray(nodes)) return false;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const kind = (node as { kind?: unknown }).kind;
    if (kind === "math-inline" || kind === "math-display") {
      return true;
    }
    if (hasMathInline((node as { children?: unknown }).children)) {
      return true;
    }
  }
  return false;
}

async function runCurrencyDoesNotTriggerStreamingMathTest(): Promise<void> {
  const content = await loadFixture("table-large.md");
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: DOC_PLUGINS,
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to initialize");
  store.reset(init.blocks);

  for (let index = 0; index < content.length; index += 34) {
    const appendMessages = await harness.send({ type: "APPEND", text: content.slice(index, index + 34) });
    applyPatchMessages(store, appendMessages);
    const provisionalParagraphs = store
      .getBlocks()
      .filter((block) => block.type === "paragraph" && !block.isFinalized && typeof block.payload.raw === "string");
    for (const block of provisionalParagraphs) {
      const raw = block.payload.raw as string;
      if (!raw.includes("$")) continue;
      assert.ok(!hasMathInline(block.payload.inline), `currency-like streaming paragraph must not produce math nodes: ${raw}`);
      const ranges = Array.isArray((block.payload.meta as { protectedRanges?: unknown } | undefined)?.protectedRanges)
        ? (((block.payload.meta as { protectedRanges?: unknown }).protectedRanges as Array<{ kind?: unknown }>) ?? [])
        : [];
      assert.ok(
        !ranges.some((range) => range?.kind === "math-inline"),
        `currency-like streaming paragraph must not carry inline math protected ranges: ${raw}`,
      );
    }
  }
}

async function runFinalizedMdxStateTest(): Promise<void> {
  const blocks = await streamFixture(await loadFixture("mdx-transitions.mdx"), 31, { mdxCompileMode: "worker" });
  const mdxBlocks = blocks.filter((block) => block.type === "mdx");
  assert.strictEqual(mdxBlocks.length, 3, "expected finalized mdx block count");

  for (const block of mdxBlocks) {
    assert.ok(block.isFinalized, `mdx block must be finalized: ${block.id}`);
    const meta = (block.payload.meta ?? {}) as { mdxStatus?: unknown };
    const status = typeof meta.mdxStatus === "string" ? meta.mdxStatus : undefined;
    assert.notStrictEqual(status, "pending", `finalized mdx block remained pending: ${block.id}`);
    if (status === "compiled") {
      assert.ok(block.payload.compiledMdxRef || block.payload.compiledMdxModule, `compiled mdx block missing artifact: ${block.id}`);
    }
    if (status === "error") {
      assert.ok(!block.payload.compiledMdxRef && !block.payload.compiledMdxModule, `errored mdx block retained artifact: ${block.id}`);
    }
    if (block.payload.compiledMdxRef && block.payload.compiledMdxModule) {
      assert.strictEqual(
        block.payload.compiledMdxRef.id,
        block.payload.compiledMdxModule.id,
        `compiled mdx ids must agree for ${block.id}`,
      );
    }
  }
}

async function runMdxTransitionsRendererStoreInvariantTest(): Promise<void> {
  const content = await loadFixture("mdx-transitions.mdx");
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: DOC_PLUGINS,
    mdx: { compileMode: "worker" },
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to initialize");
  store.reset(init.blocks);

  for (let index = 0; index < content.length; index += 31) {
    const appendMessages = await harness.send({ type: "APPEND", text: content.slice(index, index + 31) });
    for (const message of appendMessages) {
      if (message.type !== "PATCH") continue;
      const patches = message.patches as Patch[];

      const appendIndices = new Map<string, number>();
      const setPropsIndices = new Map<string, number>();
      patches.forEach((patch, patchIndex) => {
        const targetId = patch.at.nodeId ?? patch.at.blockId;
        if (patch.op === "appendLines") {
          appendIndices.set(targetId, patchIndex);
        } else if (patch.op === "setProps") {
          const blockCandidate = (patch.props as { block?: unknown } | undefined)?.block;
          if (blockCandidate && typeof blockCandidate === "object") {
            setPropsIndices.set(targetId, patchIndex);
          }
        }
      });

      for (const [targetId, appendIndex] of appendIndices) {
        const setPropsIndex = setPropsIndices.get(targetId);
        if (setPropsIndex !== undefined) {
          assert.ok(
            appendIndex < setPropsIndex,
            `appendLines must precede block setProps for ${targetId} (append=${appendIndex}, setProps=${setPropsIndex})`,
          );
        }
      }

      store.applyPatches(patches, { captureMetrics: false });
      const violations = store
        .getInvariantViolations()
        .filter((message) => message.includes("appendLines guard rejected"));
      assert.deepStrictEqual(violations, [], `renderer store rejected appendLines during mdx-transitions chunk @${index}`);
    }
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  applyPatchMessages(store, finalizeMessages);
  const finalViolations = store
    .getInvariantViolations()
    .filter((message) => message.includes("appendLines guard rejected"));
  assert.deepStrictEqual(finalViolations, [], "renderer store rejected appendLines during mdx-transitions finalize");
}

await runAppendLinesTailGuardTest();
await runStreamingTableDeferralTest();
await runCurrencyDoesNotTriggerStreamingMathTest();
await runFinalizedTableShapeTest();
await runFinalizedMdxStateTest();
await runMdxTransitionsRendererStoreInvariantTest();
console.log("worker structural regressions test passed");
