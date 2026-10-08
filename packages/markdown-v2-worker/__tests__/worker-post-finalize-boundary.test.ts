import assert from "node:assert";

import { applyPatchBatch, createBlockSnapshot, createInitialSnapshot, type Block, type NodeSnapshot, type Patch, type WorkerOut } from "@stream-mdx/core";
import { getPatchKind } from "@stream-mdx/core/perf/patch-batching";

import { createWorkerHarness } from "./worker-test-harness";
import { MarkdownEngine } from "../src/engine/engine";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import { JSDOM } from "jsdom";

function getPatchMessages(messages: WorkerOut[]): Array<Extract<WorkerOut, { type: "PATCH" }>> {
  return messages.filter((message): message is Extract<WorkerOut, { type: "PATCH" }> => message.type === "PATCH");
}

function findDumpBlocks(messages: WorkerOut[]): Extract<WorkerOut, { type: "DUMP_BLOCKS" }> {
  const dump = messages.find((message): message is Extract<WorkerOut, { type: "DUMP_BLOCKS" }> => message.type === "DUMP_BLOCKS");
  assert.ok(dump, "expected DUMP_BLOCKS response");
  return dump;
}

function buildLargeCodeSnippet(lineCount: number): string {
  const lines = Array.from({ length: lineCount }, (_, idx) => `const value_${idx} = ${idx};`);
  return ["```js", ...lines, "```"].join("\n");
}

async function runLazyTokenizationBoundaryTest(): Promise<void> {
  const harness = await createWorkerHarness();

  await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: {
      html: true,
      mdx: false,
      math: false,
      tables: false,
      callouts: false,
      lazyTokenization: { enabled: true, thresholdLines: 10 },
    },
  });

  const snippet = buildLargeCodeSnippet(64);
  await harness.send({ type: "APPEND", text: snippet });
  await harness.send({ type: "FINALIZE" });

  const beforeDump = findDumpBlocks(await harness.send({ type: "DUMP_BLOCKS" }));
  const codeBlock = beforeDump.blocks.find((block) => block.type === "code");
  assert.ok(codeBlock, "expected finalized code block");
  assert.ok(codeBlock.isFinalized, "code block must be finalized before lazy tokenization follow-up");

  const tokenizeMessages = await harness.send({
    type: "TOKENIZE_RANGE",
    blockId: codeBlock.id,
    startLine: 0,
    endLine: 64,
    priority: "visible",
  });
  const patchMessages = getPatchMessages(tokenizeMessages);
  assert.ok(patchMessages.length > 0, "expected lazy tokenization to emit follow-up patches");

  const patches = patchMessages.flatMap((message) => message.patches as Patch[]);
  assert.ok(patches.length > 0, "expected lazy tokenization patch list");
  assert.ok(
    patches.every((patch) => getPatchKind(patch) === "enrichment"),
    `lazy tokenization after finalize must emit enrichment-only patches: ${patches.map((patch) => `${patch.op}:${getPatchKind(patch)}`).join(", ")}`,
  );
  assert.ok(
    patches.every((patch) => patch.op !== "finalize"),
    "lazy tokenization follow-up must not re-emit finalize patches",
  );

  const afterDump = findDumpBlocks(await harness.send({ type: "DUMP_BLOCKS" }));
  const updatedBlock = afterDump.blocks.find((block) => block.id === codeBlock.id);
  assert.ok(updatedBlock, "expected code block after lazy tokenization");
  assert.ok(updatedBlock.isFinalized, "lazy tokenization must not reopen finalized code blocks");
}

async function runMdxStatusBoundaryTest(): Promise<void> {
  const harness = await createWorkerHarness();

  await harness.send({
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
    },
    mdx: { compileMode: "server" },
  });

  const raw = "<Preview message=\"hello\" />";
  await harness.send({ type: "APPEND", text: raw });
  await harness.send({ type: "FINALIZE" });

  const beforeDump = findDumpBlocks(await harness.send({ type: "DUMP_BLOCKS" }));
  const mdxBlock = beforeDump.blocks.find((block) => block.type === "mdx");
  assert.ok(mdxBlock, "expected finalized mdx block");
  assert.ok(mdxBlock.isFinalized, "mdx block must be finalized before coordinator status update");

  const staleMessages = await harness.send({
    type: "MDX_COMPILED",
    blockId: mdxBlock.id,
    compiledId: "compiled-stale",
    rawSignature: `${raw} stale`,
  });
  assert.strictEqual(getPatchMessages(staleMessages).length, 0, "stale finalized MDX update must be ignored");

  const validMessages = await harness.send({
    type: "MDX_COMPILED",
    blockId: mdxBlock.id,
    compiledId: "compiled-valid",
    rawSignature: raw,
  });
  const validPatches = getPatchMessages(validMessages).flatMap((message) => message.patches as Patch[]);
  assert.ok(validPatches.length > 0, "expected valid finalized MDX update to emit a patch");
  assert.ok(
    validPatches.every((patch) => getPatchKind(patch) === "semantic"),
    `finalized MDX status updates must remain semantic: ${validPatches.map((patch) => `${patch.op}:${getPatchKind(patch)}`).join(", ")}`,
  );

  const afterDump = findDumpBlocks(await harness.send({ type: "DUMP_BLOCKS" }));
  const updatedBlock = afterDump.blocks.find((block) => block.id === mdxBlock.id);
  assert.ok(updatedBlock, "expected finalized mdx block after valid update");
  assert.ok(updatedBlock.isFinalized, "MDX status updates must not reopen finalized blocks");
  assert.strictEqual(updatedBlock.payload.compiledMdxRef?.id, "compiled-valid", "expected compiled MDX ref after valid update");
}

async function runMdxErrorBoundaryTest(): Promise<void> {
  const harness = await createWorkerHarness();

  await harness.send({
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
    },
    mdx: { compileMode: "server" },
  });

  const raw = "<Preview message=\"broken\" />";
  await harness.send({ type: "APPEND", text: raw });
  await harness.send({ type: "FINALIZE" });

  const beforeDump = findDumpBlocks(await harness.send({ type: "DUMP_BLOCKS" }));
  const mdxBlock = beforeDump.blocks.find((block) => block.type === "mdx");
  assert.ok(mdxBlock, "expected finalized mdx block");
  assert.ok(mdxBlock.isFinalized, "mdx block must be finalized before coordinator error update");

  const staleMessages = await harness.send({
    type: "MDX_ERROR",
    blockId: mdxBlock.id,
    error: "stale compile failure",
    rawSignature: `${raw} stale`,
  });
  assert.strictEqual(getPatchMessages(staleMessages).length, 0, "stale finalized MDX error update must be ignored");

  const validMessages = await harness.send({
    type: "MDX_ERROR",
    blockId: mdxBlock.id,
    error: "compile failed",
    rawSignature: raw,
  });
  const validPatches = getPatchMessages(validMessages).flatMap((message) => message.patches as Patch[]);
  assert.ok(validPatches.length > 0, "expected valid finalized MDX error update to emit a patch");
  assert.ok(
    validPatches.every((patch) => getPatchKind(patch) === "semantic"),
    `finalized MDX error updates must remain semantic: ${validPatches.map((patch) => `${patch.op}:${getPatchKind(patch)}`).join(", ")}`,
  );

  const afterDump = findDumpBlocks(await harness.send({ type: "DUMP_BLOCKS" }));
  const updatedBlock = afterDump.blocks.find((block) => block.id === mdxBlock.id);
  assert.ok(updatedBlock, "expected finalized mdx block after valid error update");
  assert.ok(updatedBlock.isFinalized, "MDX error updates must not reopen finalized blocks");
  assert.strictEqual(updatedBlock.payload.compiledMdxRef?.id, undefined, "error update should clear compiled ref");
  assert.strictEqual(
    (updatedBlock.payload.meta as { mdxStatus?: string; mdxError?: string } | undefined)?.mdxStatus,
    "error",
    "expected mdx status to transition to error",
  );
}

function findNestedCode(blocks: Block[]): Block {
  const visit = (snapshot: NodeSnapshot): Block | undefined => {
    if (snapshot.type === "code") return snapshot.props?.block as Block;
    for (const child of snapshot.children ?? []) {
      const code = visit(child);
      if (code) return code;
    }
    return undefined;
  };
  for (const block of blocks) {
    const code = visit(createBlockSnapshot(block));
    if (code) return code;
  }
  throw new Error("expected prepared nested code");
}

async function runInflightLazyLifecycleTest(): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node });
  const lines = ["@@ -1,25 +1,25 @@", ...Array.from({ length: 25 }, (_, index) => [`-const oldOnlySentinel_${index} = 0;`, `+const oldOnlySentinel_${index} = 1;`]).flat()];
  const oldMarkdown = ["- owner", "", "  ```diff-js", ...lines.map((line) => `  ${line}`), "  ```"].join("\n");
  const replacement = "- owner\n\n  ```js\n  const replacementOnly = 1;\n  ```";
  const docPlugins = { html: false, mdx: false, math: false, tables: false, footnotes: false, callouts: false, outputMode: "tokens" as const, emitHighlightTokens: true, emitDiffBlocks: true, lazyTokenization: { enabled: true, thresholdLines: 10 } };
  for (const action of ["replace", "owner-update", "inside-owner", "dispose"] as const) {
    const messages: WorkerOut[] = [];
    const store = createRendererStore();
    let document = createInitialSnapshot();
    let replacementInitialized = false;
    const engine = new MarkdownEngine({ extensions: { documentPlugins: [{
      name: "native-owner-update",
      process(ctx) {
        if (ctx.content.includes("NEW_SIBLING")) {
          const owner = ctx.blocks.findIndex((block) => block.type === "list");
          assert.ok(owner >= 0);
          const block = ctx.blocks[owner];
          ctx.blocks[owner] = { ...block, payload: { ...block.payload, meta: { ...block.payload.meta, nativeOwnerRevision: "updated" } } };
        }
        return undefined;
      },
    }] }, post(emitted) {
      const message = structuredClone(emitted);
      messages.push(message);
      if (message.type === "INITIALIZED") {
        store.reset(message.blocks);
        document = createInitialSnapshot(message.blocks);
        replacementInitialized = JSON.stringify(message.blocks).includes("replacementOnly");
      } else if (message.type === "PATCH") {
        applyPatchBatch(document, message.patches);
        store.applyPatches(message.patches, { captureMetrics: false });
        if (replacementInitialized) {
          assert.ok(!JSON.stringify(store.getBlocks()).includes("oldOnlySentinel"), "old asynchronous work must never overwrite a replacement document");
        }
      } else if (message.type === "ERROR") throw new Error(message.error.message);
      assert.ok(JSON.stringify(document.blocks) === JSON.stringify(store.getBlocks()), "serialized core and React consumers must remain equivalent");
      assert.deepStrictEqual(store.getInvariantViolations(), []);
    } });
    await engine.handle({ type: "INIT", initialContent: oldMarkdown, prewarmLangs: [], docPlugins });
    await engine.handle({ type: "FINALIZE" });
    const oldCode = findNestedCode(store.getBlocks());
    assert.strictEqual(oldCode.payload.meta?.lazyTokenizedUntil, 0);
    const beforeRequest = messages.length;
    const requestedEnd = action === "inside-owner" ? 27 : lines.length;
    await engine.handle({ type: "TOKENIZE_RANGE", blockId: oldCode.id, startLine: 0, endLine: requestedEnd, priority: "visible" });
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(getPatchMessages(messages.slice(beforeRequest)).length, 0, "real multi-run diff tokenization must still be in flight at the lifecycle transition");
    if (action === "replace") {
      await engine.handle({ type: "INIT", initialContent: replacement, prewarmLangs: [], docPlugins });
      assert.strictEqual(findNestedCode(store.getBlocks()).id, oldCode.id, "replacement must reuse the descendant ID so ID-only guards cannot pass");
      await engine.handle({ type: "FINALIZE" });
    } else if (action === "owner-update") {
      await engine.handle({ type: "APPEND", text: "\n\nNEW_SIBLING" });
    } else if (action === "inside-owner") {
      await engine.handle({ type: "APPEND", text: "\n\n  Inside owner\n\nNEW_SIBLING" });
    } else {
      engine.dispose();
    }
    const afterTransition = messages.length;
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (action === "dispose") {
      assert.strictEqual(messages.length, afterTransition, "disposed engines must not emit stale asynchronous completion");
    } else {
      await engine.handle({ type: "DUMP_BLOCKS" });
      const dumped = findDumpBlocks(messages.slice(afterTransition)).blocks;
      assert.ok(JSON.stringify(dumped) === JSON.stringify(store.getBlocks()), "the canonical engine artifact must match both serialized consumers");
      const code = findNestedCode(dumped);
      if (action === "replace") {
        assert.strictEqual(code.payload.meta?.code, "const replacementOnly = 1;");
        assert.ok(code.isFinalized);
        assert.ok(dumped.every((block) => block.isFinalized));
        assert.ok(messages.slice(beforeRequest).some((message) => message.type === "FINALIZED"));
        assert.ok(!JSON.stringify(dumped).includes("oldOnlySentinel"));
      } else {
        assert.strictEqual(code.payload.meta?.lazyTokenizedUntil, requestedEnd, "unchanged source leaves must complete against the fresh COW owner");
        assert.strictEqual(dumped.find((block) => block.type === "list")?.payload.meta?.nativeOwnerRevision, "updated", "lazy completion must preserve new ancestor metadata");
        assert.ok(dumped.some((block) => block.payload.raw?.includes("NEW_SIBLING")), "lazy completion must preserve new siblings");
        if (action === "inside-owner") {
          assert.ok(dumped.find((block) => block.type === "list")?.payload.raw?.includes("Inside owner"));
          const tailStart = messages.length;
          await engine.handle({ type: "TOKENIZE_RANGE", blockId: code.id, startLine: requestedEnd, endLine: lines.length, priority: "visible" });
          await new Promise<void>((resolve) => setImmediate(resolve));
          await engine.handle({ type: "DUMP_BLOCKS" });
          const completed = findNestedCode(findDumpBlocks(messages.slice(tailStart)).blocks);
          const fullMessages: WorkerOut[] = [];
          const full = new MarkdownEngine({ post: (message) => fullMessages.push(structuredClone(message)) });
          await full.handle({ type: "INIT", initialContent: oldMarkdown, prewarmLangs: [], docPlugins: { ...docPlugins, lazyTokenization: { enabled: false } } });
          await full.handle({ type: "FINALIZE" });
          await full.handle({ type: "DUMP_BLOCKS" });
          const expected = findNestedCode(findDumpBlocks(fullMessages).blocks);
          assert.strictEqual(completed.payload.meta?.lazyTokenizedUntil, lines.length);
          for (const key of ["tokenLines", "diffKind", "oldNo", "newNo", "diffBlocks"]) {
            const actualValue = completed.payload.meta?.[key];
            const expectedValue = expected.payload.meta?.[key];
            const index = Array.isArray(actualValue) && Array.isArray(expectedValue) ? actualValue.findIndex((value, index) => JSON.stringify(value) !== JSON.stringify(expectedValue[index])) : -1;
            assert.ok(JSON.stringify(actualValue) === JSON.stringify(expectedValue), `continued ${key} mismatch at ${index}: actual ${Array.isArray(actualValue) ? JSON.stringify(actualValue[index]) : typeof actualValue}, expected ${Array.isArray(expectedValue) ? JSON.stringify(expectedValue[index]) : typeof expectedValue}`);
          }
          full.dispose();
        }
      }
      engine.dispose();
    }
  }
  dom.window.close();
}

await runLazyTokenizationBoundaryTest();
await runMdxStatusBoundaryTest();
await runMdxErrorBoundaryTest();
await runInflightLazyLifecycleTest();
console.log("worker-post-finalize-boundary test passed");
