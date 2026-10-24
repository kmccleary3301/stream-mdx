import assert from "node:assert";

import { createBlockSnapshot, PATCH_ROOT_ID, type Block, type Patch } from "@stream-mdx/core";

import { createRendererStore } from "../src/renderer/store";



function createParagraphBlock(raw: string): Block {
  return {
    id: "paragraph-block",
    type: "paragraph",
    isFinalized: false,
    payload: {
      raw,
    },
  };
}

function createCodeBlock(): Block {
  return {
    id: "code-block",
    type: "code",
    isFinalized: false,
    payload: {
      raw: ["alpha()", "beta()"].join("\n"),
      meta: { lang: "ts" },
    },
  };
}

async function main() {
  const store = createRendererStore([createParagraphBlock("alpha")]);

  const initial = store.getNode("paragraph-block");
  assert.ok(initial, "expected paragraph block node to exist");
  const staleEpoch = initial.blockEpoch;

  store.applyPatches([
    {
      op: "setProps",
      at: { blockId: "paragraph-block", nodeId: "paragraph-block" },
      props: {
        block: createParagraphBlock("beta"),
      },
    } satisfies Patch,
  ]);

  const replaced = store.getNode("paragraph-block");
  assert.ok(replaced, "expected paragraph block node after semantic replacement");
  assert.ok(replaced.blockEpoch > staleEpoch, "semantic block replacement should advance block epoch");
  assert.strictEqual(replaced.block?.payload.raw, "beta", "expected semantic replacement to update block payload");
  const replacedEpoch = replaced.blockEpoch;

  store.applyPatches([
    {
      op: "setProps",
      at: { blockId: "paragraph-block", nodeId: "paragraph-block" },
      props: {
        staleMarker: "should-not-land",
      },
      meta: {
        kind: "semantic",
        blockEpoch: staleEpoch,
      },
    } satisfies Patch,
  ]);

  const afterRejected = store.getNode("paragraph-block");
  assert.ok(afterRejected, "expected paragraph block node after stale rejection");
  assert.strictEqual(
    afterRejected.props?.staleMarker,
    undefined,
    "stale semantic patch should be rejected without mutating target props",
  );

  const counters = store.getDebugCounters();
  assert.strictEqual(counters.staleEpochRejected, 1, "expected stale epoch rejection counter to increment");

  const violations = store.getInvariantViolations();
  assert.ok(
    violations.some((message) => message.includes("stale epoch rejected:setProps:paragraph-block")),
    "expected stale epoch rejection to be recorded in diagnostics",
  );

  const codeStore = createRendererStore([createCodeBlock()]);
  const initialCode = codeStore.getNode("code-block");
  assert.ok(initialCode, "expected code block node");
  const initialCodeEpoch = initialCode.blockEpoch;
  const codeLineId = initialCode.children[0];
  assert.ok(typeof codeLineId === "string" && codeLineId.length > 0, "expected first code line child");

  codeStore.applyPatches([
    {
      op: "setProps",
      at: { blockId: "code-block", nodeId: codeLineId },
      props: {
        index: 0,
        text: "alpha(updated)",
      },
      meta: {
        kind: "semantic",
        blockEpoch: initialCodeEpoch,
        parseEpoch: initialCodeEpoch + 1,
        tx: 101,
      },
    } satisfies Patch,
  ]);

  const updatedCode = codeStore.getNode("code-block");
  assert.ok(updatedCode, "expected code block after semantic line update");
  assert.ok(updatedCode.blockEpoch > initialCodeEpoch, "semantic code-line update should advance owning block epoch");
  const canonicalCodeStore = createRendererStore();
  const canonicalCodeRaw = "alpha";
  const canonicalCodeGeneration = 29;
  canonicalCodeStore.resetSnapshot({
    id: PATCH_ROOT_ID,
    type: "__root__",
    inputSource: { generation: canonicalCodeGeneration, raw: canonicalCodeRaw },
    children: [createBlockSnapshot({
      id: "canonical-code",
      type: "code",
      isFinalized: false,
      payload: { raw: canonicalCodeRaw, meta: { lang: "ts" } },
    })],
  });
  const canonicalCode = canonicalCodeStore.getNode("canonical-code");
  assert.ok(canonicalCode);
  const canonicalLineId = canonicalCode.children[0];
  assert.ok(canonicalLineId);
  const capturedCanonicalBlock = canonicalCodeStore.getBlocks()[0];
  assert.ok(capturedCanonicalBlock);
  const updatedCanonicalRaw = "alpha(updated)";
  canonicalCodeStore.applyPatches([
    {
      op: "appendInputSource",
      at: { blockId: PATCH_ROOT_ID },
      generation: canonicalCodeGeneration,
      from: canonicalCodeRaw.length,
      text: "(updated)",
    },
    {
      op: "setProps",
      at: { blockId: "canonical-code", nodeId: canonicalLineId },
      props: { index: 0, text: updatedCanonicalRaw },
      meta: {
        kind: "semantic",
        blockEpoch: canonicalCode.blockEpoch,
        parseEpoch: canonicalCode.blockEpoch + 1,
        tx: 201,
      },
    },
  ]);
  assert.equal(canonicalCodeStore.getCodeLines("canonical-code", 0, 1)[0]?.text, updatedCanonicalRaw, "legacy nested line updates can validate against appended canonical input");
  assert.deepStrictEqual(
    canonicalCodeStore.getCodeBlock("canonical-code")?.source.sourceRange,
    { from: 0, to: updatedCanonicalRaw.length },
    "the updated legacy source window remains bounded to its canonical range",
  );
  assert.equal(capturedCanonicalBlock.payload.raw, canonicalCodeRaw, "captured canonical legacy windows remain immutable");
  assert.equal(canonicalCodeStore.getBlocks()[0]?.payload.raw, updatedCanonicalRaw, "the current legacy export reflects the validated canonical window");

  store.applyPatches([
    {
      op: "insertChild",
      at: { blockId: PATCH_ROOT_ID },
      index: 1,
      node: {
        id: "footnote-block",
        type: "footnotes",
        props: {},
        children: [],
        meta: {
          blockEpoch: 7,
        },
      },
      meta: {
        kind: "semantic",
        blockEpoch: 7,
      },
    } satisfies Patch,
  ]);

  const inserted = store.getNode("footnote-block");
  assert.ok(inserted, "root insertChild patches should not be stale-rejected against the synthetic root epoch");
  assert.strictEqual(
    store.getDebugCounters().staleEpochRejected,
    1,
    "root insertChild should not increment stale epoch rejection count",
  );

  // Streaming an HTML block: each setHTML expects the epoch the previous one established (worker sequence).
  const htmlBlock = (raw: string, html: string): Block => ({
    id: "html-block",
    type: "html",
    isFinalized: false,
    payload: { raw, sanitizedHtml: html, meta: { sanitized: true } },
  });
  const htmlStore = createRendererStore([]);
  htmlStore.applyPatches([
    {
      op: "insertChild",
      at: { blockId: PATCH_ROOT_ID },
      index: 0,
      node: { id: "html-block", type: "html", props: { block: htmlBlock("<table>", "") } },
      meta: { kind: "semantic", parseEpoch: 6, tx: 6 },
    } satisfies Patch,
  ]);
  const steps: Array<[raw: string, html: string, expectedEpoch: number, parseEpoch: number]> = [
    ["<table>", "<table></table>", 6, 7],
    ["<table>\n  <tr>", "<table><tbody><tr></tr></tbody></table>", 7, 11],
    ["<table>\n  <tr>\n  </tr>\n</table>", "<table><tbody><tr>\n  </tr></tbody></table>", 11, 12],
  ];
  const htmlPatches = steps.map(([raw, html, expectedEpoch, parseEpoch]) => ({
    op: "setHTML",
    at: { blockId: "html-block" },
    html,
    sanitized: true,
    policy: "markdown-renderer-v2",
    block: htmlBlock(raw, html),
    patchMeta: { kind: "semantic", parseEpoch, tx: parseEpoch, blockEpoch: expectedEpoch },
  } satisfies Patch));
  for (const patch of htmlPatches) {
    htmlStore.applyPatches([patch]);
  }
  const streamedHtml = htmlStore.getNode("html-block");
  assert.ok(streamedHtml, "expected the streamed HTML block");
  const finalRaw = "<table>\n  <tr>\n  </tr>\n</table>";
  const finalHtml = "<table><tbody><tr>\n  </tr></tbody></table>";
  assert.strictEqual(streamedHtml.block?.payload.raw, finalRaw, "every streamed setHTML must apply");
  assert.strictEqual(streamedHtml.block?.payload.sanitizedHtml, finalHtml, "the newest sanitized HTML must be stored");
  assert.strictEqual(streamedHtml.props.html, finalHtml, "the renderer must receive the newest sanitized HTML");
  assert.strictEqual(streamedHtml.blockEpoch, 12, "valid HTML updates must advance the block epoch");
  const finalEpoch = streamedHtml.blockEpoch;
  const rejectionCount = htmlStore.getDebugCounters().staleEpochRejected;
  assert.strictEqual(rejectionCount, 0, "in-order setHTML patches are not stale");

  // Replay an older semantic result with its original HTML-specific epoch metadata.
  htmlStore.applyPatches([htmlPatches[0]]);
  const afterStaleHtml = htmlStore.getNode("html-block");
  assert.ok(afterStaleHtml, "expected the HTML block after stale replay");
  assert.strictEqual(afterStaleHtml.block?.payload.raw, finalRaw, "stale HTML must not overwrite the newest raw content");
  assert.strictEqual(afterStaleHtml.block?.payload.sanitizedHtml, finalHtml, "stale HTML must not overwrite sanitized content");
  assert.strictEqual(afterStaleHtml.props.html, finalHtml, "stale HTML must not overwrite renderer HTML");
  assert.strictEqual(afterStaleHtml.blockEpoch, finalEpoch, "stale HTML must not advance or reset the block epoch");
  assert.strictEqual(
    htmlStore.getDebugCounters().staleEpochRejected,
    rejectionCount + 1,
    "replaying an old setHTML patch must increment the stale rejection counter",
  );
  const inheritedStore = createRendererStore();
  inheritedStore.resetSnapshot({
    id: PATCH_ROOT_ID,
    type: "__root__",
    children: [
      {
        id: "epoch-parent",
        type: "container",
        props: {},
        meta: { blockEpoch: 7 },
        children: [{ id: "epoch-child", type: "leaf", props: {} }],
      },
    ],
  });
  const initialChild = inheritedStore.getNode("epoch-child");
  assert.ok(initialChild);
  const initialEpoch = initialChild.blockEpoch;
  const publishedParent = inheritedStore.getNodeWithVersion("epoch-parent");
  assert.strictEqual(publishedParent.node?.blockEpoch, initialEpoch);
  const publishedChild = inheritedStore.getNodeWithVersion("epoch-child");
  assert.strictEqual(publishedChild.node?.blockEpoch, initialEpoch);
  inheritedStore.applyPatches([
    {
      op: "setProps",
      at: { blockId: "epoch-parent", nodeId: "epoch-parent" },
      props: { layoutRevision: 1 },
      meta: { kind: "semantic" },
    } satisfies Patch,
  ]);
  const currentChild = inheritedStore.getNode("epoch-child");
  const currentChildSnapshot = inheritedStore.getNodeWithVersion("epoch-child");
  const currentParentSnapshot = inheritedStore.getNodeWithVersion("epoch-parent");
  assert.ok(currentChild);
  assert.ok(currentChild.blockEpoch > initialEpoch, "child reads expose the current inherited block epoch");
  const currentParent = currentParentSnapshot.node;
  assert.ok(currentParent && currentParent.blockEpoch > initialEpoch);
  assert.strictEqual(
    publishedChild.node?.blockEpoch,
    initialEpoch,
    "previously published node snapshots retain their epoch value",
  );
  assert.strictEqual(
    publishedParent.node?.blockEpoch,
    initialEpoch,
    "previously published direct-owner reads retain their epoch value",
  );
  assert.strictEqual(currentChildSnapshot.node?.blockEpoch, currentChild.blockEpoch);
  inheritedStore.applyPatches([
    {
      op: "setProps",
      at: { blockId: "epoch-parent", nodeId: "epoch-child" },
      props: { staleMarker: true },
      meta: { kind: "semantic", blockEpoch: initialEpoch },
    } satisfies Patch,
  ]);
  assert.strictEqual(inheritedStore.getNode("epoch-child")?.props.staleMarker, undefined);
  assert.ok(
    inheritedStore.getInvariantViolations().some((message) =>
      message.includes(`stale epoch rejected:setProps:epoch-parent:expected=${initialEpoch}:actual=${currentChild.blockEpoch}`),
    ),
    "epoch guards compare patches against the same inherited epoch exposed by node reads",
  );
  inheritedStore.applyPatches([
    {
      op: "setProps",
      at: { blockId: "epoch-parent", nodeId: "epoch-child" },
      props: { currentMarker: true },
      meta: { kind: "semantic", blockEpoch: currentChild.blockEpoch },
    } satisfies Patch,
  ]);
  assert.strictEqual(inheritedStore.getNode("epoch-child")?.props.currentMarker, true);
  const publishedChildren = inheritedStore.getChildrenWithVersion("epoch-parent");
  inheritedStore.applyPatches([
    {
      op: "insertChild",
      at: { blockId: "epoch-parent" },
      index: 1,
      node: { id: "epoch-appended-child", type: "leaf", props: {}, children: [] },
    } satisfies Patch,
  ]);
  assert.deepStrictEqual(publishedChildren.children, ["epoch-child"]);
  assert.deepStrictEqual(
    inheritedStore.getChildrenWithVersion("epoch-parent").children,
    ["epoch-child", "epoch-appended-child"],
  );

  // The worker records a finalize as the block's emitted epoch, so the next patch to that block expects it.
  const finalizeStore = createRendererStore([createParagraphBlock("alpha")]);
  const openEpoch = finalizeStore.getNode("paragraph-block")?.blockEpoch ?? 0;
  const finalizeEpoch = openEpoch + 5;
  finalizeStore.applyPatches([
    {
      op: "finalize",
      at: { blockId: "paragraph-block" },
      meta: { kind: "semantic", blockEpoch: openEpoch, parseEpoch: finalizeEpoch, tx: 301 },
    } satisfies Patch,
  ]);
  finalizeStore.applyPatches([
    {
      op: "setProps",
      at: { blockId: "paragraph-block" },
      props: { afterFinalize: true },
      meta: { kind: "semantic", blockEpoch: finalizeEpoch, parseEpoch: finalizeEpoch + 1, tx: 302 },
    } satisfies Patch,
  ]);
  assert.strictEqual(finalizeStore.getNode("paragraph-block")?.block?.isFinalized, true);
  assert.strictEqual(finalizeStore.getNode("paragraph-block")?.props.afterFinalize, true, "a patch after finalize must not be stale");
  assert.strictEqual(finalizeStore.getDebugCounters().staleEpochRejected, 0);

  // Patches of one transaction all carry the epoch from before it; a root replace after the block's finalize
  // belongs to the same transaction and must still apply.
  const sameTxStore = createRendererStore([createParagraphBlock("alpha")]);
  const beforeTxEpoch = sameTxStore.getNode("paragraph-block")?.blockEpoch ?? 0;
  const txMeta = { kind: "semantic", blockEpoch: beforeTxEpoch, parseEpoch: beforeTxEpoch + 5, tx: 401 } as const;
  sameTxStore.applyPatches([
    { op: "finalize", at: { blockId: "paragraph-block" }, meta: txMeta } satisfies Patch,
    {
      op: "replaceChild",
      at: { blockId: PATCH_ROOT_ID },
      index: 0,
      node: createBlockSnapshot({ ...createParagraphBlock("omega"), isFinalized: true }),
      meta: txMeta,
    } satisfies Patch,
  ]);
  assert.strictEqual(sameTxStore.getNode("paragraph-block")?.block?.payload.raw, "omega", "the same transaction's replace applies");
  assert.strictEqual(sameTxStore.getDebugCounters().staleEpochRejected, 0);

  const replayStore = createRendererStore([createParagraphBlock("initial paragraph")]);
  const replayInitial = replayStore.getNode("paragraph-block");
  assert.ok(replayInitial, "expected the paragraph before semantic envelope replay");
  const matchingEpoch = replayInitial.blockEpoch;
  const olderEnvelopeMeta = {
    kind: "semantic",
    streamSeq: 401,
    parseEpoch: matchingEpoch,
    tx: 401,
    blockEpoch: matchingEpoch,
  } as const;
  const olderEnvelope: Patch[] = [
    {
      op: "finalize",
      at: { blockId: "paragraph-block" },
      meta: olderEnvelopeMeta,
    },
    {
      op: "replaceChild",
      at: { blockId: PATCH_ROOT_ID },
      index: 0,
      node: createBlockSnapshot({ ...createParagraphBlock("older paragraph value"), isFinalized: true }),
      meta: olderEnvelopeMeta,
    },
  ];
  replayStore.applyPatches(olderEnvelope);
  assert.strictEqual(
    replayStore.getBlocks()[0]?.payload.raw,
    "older paragraph value",
    "both same-tuple patches in one semantic envelope should apply",
  );

  replayStore.applyPatches([
    {
      op: "replaceChild",
      at: { blockId: PATCH_ROOT_ID },
      index: 0,
      node: createBlockSnapshot({ ...createParagraphBlock("newest paragraph value"), isFinalized: true }),
      meta: {
        kind: "semantic",
        streamSeq: 402,
        parseEpoch: matchingEpoch,
        tx: 402,
        blockEpoch: matchingEpoch,
      },
    } satisfies Patch,
  ]);
  assert.strictEqual(
    replayStore.getBlocks()[0]?.payload.raw,
    "newest paragraph value",
    "the newer semantic envelope should become the observed content",
  );

  replayStore.applyPatches(olderEnvelope);
  assert.strictEqual(
    replayStore.getBlocks()[0]?.payload.raw,
    "newest paragraph value",
    "replaying an older semantic envelope must not revert the newest paragraph value",
  );
  const cycleStore = createRendererStore([createParagraphBlock("cycle-safe paragraph")]);
  const cycleParent = cycleStore.getNode("paragraph-block");
  assert.ok(cycleParent, "expected parent before attempting a cyclic child insertion");
  cycleStore.applyPatches([
    {
      op: "insertChild",
      at: { blockId: "paragraph-block", nodeId: "paragraph-block" },
      index: 0,
      node: {
        id: "paragraph-block",
        type: "paragraph-text",
        props: { text: "must not replace its own parent" },
        children: [],
      },
      meta: { kind: "semantic", blockEpoch: cycleParent.blockEpoch, parseEpoch: cycleParent.blockEpoch + 1, tx: 501 },
    } satisfies Patch,
  ]);
  const afterCycleRejection = cycleStore.getNode("paragraph-block");
  assert.equal(afterCycleRejection?.type, "paragraph", "a self-parenting child patch must not replace its parent");
  assert.deepEqual(afterCycleRejection?.children, [], "a self-parenting child patch must not add a child");
  assert.ok(
    cycleStore.getInvariantViolations().some((message) =>
      message.includes("parent cycle rejected:insertChild:paragraph-block"),
    ),
    "a self-parenting child patch must be rejected and reported",
  );

}

await main();
console.log("stale-epoch-guard test passed");
