import assert from "node:assert";

import { PATCH_ROOT_ID, type Block, type Patch } from "@stream-mdx/core";

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
}

await main();
console.log("stale-epoch-guard test passed");
