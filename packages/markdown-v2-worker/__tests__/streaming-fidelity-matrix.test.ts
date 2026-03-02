import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";

import type { Block, Patch, WorkerOut } from "@stream-mdx/core";
import { blocksStructurallyEqual } from "@stream-mdx/core";
import { PATCH_ROOT_ID } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { JSDOM } from "jsdom";

import { createWorkerHarness } from "./worker-test-harness";

type CreditProfile = (chunkIndex: number) => number;

type Scenario = {
  name: string;
  doc: string;
  chunkSize: number;
  preAppendCredit: CreditProfile;
  postAppendCredit?: CreditProfile;
  postAppendEvery?: number;
};

function ensureDom() {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
    return;
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
  (globalThis as any).Node = dom.window.Node;
}

function applyPatchMessages(store: ReturnType<typeof createRendererStore>, messages: WorkerOut[]): void {
  for (const msg of messages) {
    if (msg.type !== "PATCH") continue;
    store.applyPatches(msg.patches as Patch[]);
  }
}

function countPatchOps(messages: WorkerOut[]): number {
  return messages
    .filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH")
    .reduce((sum, msg) => sum + msg.patches.length, 0);
}

function blockSignature(block: Block): string {
  return JSON.stringify({
    id: block.id,
    type: block.type,
    isFinalized: block.isFinalized,
    raw: block.payload.raw ?? "",
    meta: block.payload.meta ?? null,
  });
}

const STABILITY_MARGIN_CHARS = 320;

function isStableAgainstTail(block: Block | undefined, consumedChars: number): boolean {
  const to = typeof block?.payload?.range?.to === "number" ? (block.payload.range.to as number) : null;
  if (to === null) return false;
  return to <= Math.max(0, consumedChars - STABILITY_MARGIN_CHARS);
}

function assertFinalizedPrefixMatchesBaseline(
  current: ReadonlyArray<Block>,
  baseline: ReadonlyArray<Block>,
  consumedChars: number,
  label: string,
): void {
  const dirtyIndices: number[] = [];
  const dirtyDetails: string[] = [];
  for (let i = 0; i < current.length; i++) {
    if (!current[i].isFinalized) {
      dirtyIndices.push(i);
      const range = current[i].payload.range;
      dirtyDetails.push(
        `${i}:${current[i].id}:${current[i].type}:range=${range ? `${range.from}-${range.to}` : "na"}`,
      );
    }
  }
  assert.ok(
    dirtyIndices.length <= 1,
    `[${label}] expected at most one dirty block, found ${dirtyIndices.length} (${dirtyDetails.join(", ")})`,
  );
  if (dirtyIndices.length === 1) {
    assert.strictEqual(dirtyIndices[0], current.length - 1, `[${label}] dirty block must be tail`);
  }

  const finalizedCount = dirtyIndices.length === 0 ? current.length : dirtyIndices[0];

  assert.ok(
    finalizedCount <= baseline.length,
    `[${label}] finalized prefix length (${finalizedCount}) exceeds baseline length (${baseline.length})`,
  );

  for (let i = 0; i < finalizedCount; i++) {
    const curr = current[i];
    const base = baseline[i];
    if (!isStableAgainstTail(base, consumedChars)) {
      continue;
    }
    assert.ok(base, `[${label}] missing baseline block at index ${i}`);
    assert.strictEqual(curr.id, base.id, `[${label}] finalized block id drift at index ${i}: ${curr.id} != ${base.id}`);
    assert.ok(
      blocksStructurallyEqual(curr, base),
      `[${label}] finalized block diverged at index ${i} (${curr.id})\n` +
        `current: type=${curr.type} finalized=${curr.isFinalized} raw=${JSON.stringify((curr.payload.raw ?? "").slice(0, 120))}\n` +
        `baseline: type=${base.type} finalized=${base.isFinalized} raw=${JSON.stringify((base.payload.raw ?? "").slice(0, 120))}\n` +
        `currentMetaKeys=${Object.keys(curr.payload.meta ?? {}).join(",")} baselineMetaKeys=${Object.keys(base.payload.meta ?? {}).join(",")}`,
    );
  }

}

function assertFinalizedBlocksImmutable(
  current: ReadonlyArray<Block>,
  seenSignatures: Map<string, string>,
  consumedChars: number,
  label: string,
): void {
  for (const block of current) {
    if (!block.isFinalized) continue;
    if (!isStableAgainstTail(block, consumedChars)) continue;
    const signature = blockSignature(block);
    const previous = seenSignatures.get(block.id);
    if (previous === undefined) {
      seenSignatures.set(block.id, signature);
      continue;
    }
    assert.strictEqual(previous, signature, `[${label}] finalized block mutated after finalization (${block.id})`);
  }
}

function assertNoEmptyNestedLists(store: ReturnType<typeof createRendererStore>, label: string): void {
  const stack = [...store.getChildren(PATCH_ROOT_ID)];
  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (!nodeId) continue;
    const node = store.getNode(nodeId);
    if (!node) continue;
    const children = store.getChildren(nodeId);

    if (node.type === "list") {
      const parent = node.parentId ? store.getNode(node.parentId) : undefined;
      if (parent?.type === "list-item") {
        assert.ok(children.length > 0, `[${label}] found empty nested list under list-item (${nodeId})`);
      }
    }

    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
  }
}

function assertCodeLineOrdering(store: ReturnType<typeof createRendererStore>, label: string): void {
  const stack = [...store.getChildren(PATCH_ROOT_ID)];
  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (!nodeId) continue;
    const node = store.getNode(nodeId);
    if (!node) continue;
    const children = store.getChildren(nodeId);

    if (node.type === "code") {
      let expectedIndex = 0;
      for (const childId of children) {
        const lineNode = store.getNode(childId);
        assert.ok(lineNode, `[${label}] missing code line node ${childId}`);
        assert.strictEqual(lineNode?.type, "code-line", `[${label}] non code-line child under code block ${nodeId}`);
        const actualIndex = Number(lineNode?.props?.index);
        assert.strictEqual(actualIndex, expectedIndex, `[${label}] code line index drift in ${nodeId}: ${actualIndex} != ${expectedIndex}`);
        expectedIndex += 1;
      }
    }

    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
  }
}

function assertFinalizedTableShape(blocks: ReadonlyArray<Block>, label: string): void {
  for (const block of blocks) {
    if (block.type !== "table" || !block.isFinalized) continue;
    const meta = (block.payload.meta ?? {}) as {
      header?: unknown;
      rows?: unknown;
    };
    const header = Array.isArray(meta.header) ? (meta.header as unknown[]) : [];
    const rows = Array.isArray(meta.rows) ? (meta.rows as unknown[]) : [];
    if (header.length === 0 || rows.length === 0) continue;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      assert.ok(Array.isArray(row), `[${label}] table row ${rowIndex} is not an array`);
      assert.strictEqual(
        (row as unknown[]).length,
        header.length,
        `[${label}] finalized table row width mismatch at row ${rowIndex}: ${(row as unknown[]).length} != ${header.length}`,
      );
    }
  }
}

async function createInitializedHarnessStore() {
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
      liveCodeHighlighting: false,
    },
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to emit INITIALIZED");
  store.reset(init.blocks);
  return { harness, store };
}

async function computeBaseline(doc: string): Promise<Block[]> {
  const { harness, store } = await createInitializedHarnessStore();
  const append = await harness.send({ type: "APPEND", text: doc });
  applyPatchMessages(store, append);
  const finalize = await harness.send({ type: "FINALIZE" });
  applyPatchMessages(store, finalize);
  const flushCredits = await harness.send({ type: "SET_CREDITS", credits: 1 });
  applyPatchMessages(store, flushCredits);
  return store.getBlocks().map((block) => ({
    ...block,
    payload: { ...block.payload, meta: block.payload.meta ? JSON.parse(JSON.stringify(block.payload.meta)) : undefined },
  }));
}

async function runScenario(scenario: Scenario, baseline: Block[]): Promise<void> {
  const { harness, store } = await createInitializedHarnessStore();
  const seenFinalized = new Map<string, string>();

  for (let idx = 0, chunkIndex = 0; idx < scenario.doc.length; idx += scenario.chunkSize, chunkIndex++) {
    const preCredit = scenario.preAppendCredit(chunkIndex);
    const preCreditMessages = await harness.send({ type: "SET_CREDITS", credits: preCredit });
    applyPatchMessages(store, preCreditMessages);

    const chunk = scenario.doc.slice(idx, idx + scenario.chunkSize);
    const appendMessages = await harness.send({ type: "APPEND", text: chunk });
    applyPatchMessages(store, appendMessages);

    if (scenario.postAppendCredit && scenario.postAppendEvery && chunkIndex % scenario.postAppendEvery === 0) {
      const postCredit = scenario.postAppendCredit(chunkIndex);
      const postCreditMessages = await harness.send({ type: "SET_CREDITS", credits: postCredit });
      applyPatchMessages(store, postCreditMessages);
    }

    const blocks = store.getBlocks();
    const stepLabel = `${scenario.name}:chunk=${chunkIndex}`;
    const consumedChars = Math.min(scenario.doc.length, idx + scenario.chunkSize);
    assertFinalizedPrefixMatchesBaseline(blocks, baseline, consumedChars, stepLabel);
    assertFinalizedBlocksImmutable(blocks, seenFinalized, consumedChars, stepLabel);
    assertFinalizedTableShape(blocks, stepLabel);
    assertNoEmptyNestedLists(store, stepLabel);
    assertCodeLineOrdering(store, stepLabel);
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  applyPatchMessages(store, finalizeMessages);
  const postFinalizeCredits = await harness.send({ type: "SET_CREDITS", credits: 1 });
  applyPatchMessages(store, postFinalizeCredits);

  const postFinalizeOps = countPatchOps(postFinalizeCredits);
  assert.strictEqual(
    postFinalizeOps,
    0,
    `[${scenario.name}] expected FINALIZE to drain deferred queue, but post-finalize credits emitted ${postFinalizeOps} patch ops`,
  );

  const finalBlocks = store.getBlocks();
  assert.strictEqual(finalBlocks.length, baseline.length, `[${scenario.name}] block count mismatch`);
  for (let i = 0; i < baseline.length; i++) {
    const expected = baseline[i];
    const actual = finalBlocks[i];
    assert.ok(actual, `[${scenario.name}] missing final block at index ${i}`);
    assert.strictEqual(actual.id, expected.id, `[${scenario.name}] final id mismatch at index ${i}`);
    assert.ok(blocksStructurallyEqual(actual, expected), `[${scenario.name}] final block diverged at index ${i} (${actual.id})`);
  }
}

async function runStreamingFidelityMatrixTest(): Promise<void> {
  ensureDom();
  const fixturePath = path.resolve(process.cwd(), "../../apps/docs/app/demo/naive-bayes-classifier.mdx");
  const fixtureRaw = await fs.readFile(fixturePath, "utf8");
  const fullDoc = fixtureRaw.replace(/^---[\s\S]*?---\s*/, "");
  const lowSpeedWindowChars = 3072;
  const lowSpeedDoc = fullDoc.slice(0, Math.min(fullDoc.length, lowSpeedWindowChars));

  const fullBaseline = await computeBaseline(fullDoc);
  const lowSpeedBaseline = await computeBaseline(lowSpeedDoc);

  const scenarios: Array<{ scenario: Scenario; baseline: Block[] }> = [
    {
      scenario: {
        name: "full-steady-89",
        doc: fullDoc,
        chunkSize: 89,
        preAppendCredit: () => 1,
      },
      baseline: fullBaseline,
    },
    {
      scenario: {
        name: "full-oscillating-233",
        doc: fullDoc,
        chunkSize: 233,
        preAppendCredit: (chunkIndex) => [1, 0.72, 0.48, 0.22, 0.65][chunkIndex % 5],
        postAppendCredit: (chunkIndex) => [0.35, 1, 0.55, 1][chunkIndex % 4],
        postAppendEvery: 2,
      },
      baseline: fullBaseline,
    },
    {
      scenario: {
        name: "prefix-low-speed-1",
        doc: lowSpeedDoc,
        chunkSize: 1,
        preAppendCredit: (chunkIndex) => (chunkIndex % 7 === 0 ? 0.3 : chunkIndex % 5 === 0 ? 0.55 : 1),
        postAppendCredit: (chunkIndex) => (chunkIndex % 3 === 0 ? 1 : 0.4),
        postAppendEvery: 3,
      },
      baseline: lowSpeedBaseline,
    },
  ];

  for (const entry of scenarios) {
    await runScenario(entry.scenario, entry.baseline);
  }
}

await runStreamingFidelityMatrixTest();
console.log("streaming fidelity matrix regression test passed");
