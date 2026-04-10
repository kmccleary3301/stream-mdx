import assert from "node:assert";

import type { Block, Patch } from "@stream-mdx/core";
import DOMPurifyFactory from "dompurify";

import { createRendererStore } from "../src/renderer/store";

const dompurifyShim = DOMPurifyFactory as unknown as { sanitize?: (html: string, config?: unknown) => string };
if (typeof dompurifyShim.sanitize !== "function") {
  dompurifyShim.sanitize = (html: string) => html;
}

function createFinalizedCodeBlock(): Block {
  return {
    id: "code-block",
    type: "code",
    isFinalized: true,
    payload: {
      raw: ["```ts", "const answer = 42;", "```"].join("\n"),
      meta: {
        lang: "ts",
        code: "const answer = 42;",
        lazyTokenization: true,
        lazyTokenizedUntil: 0,
        highlightedLines: [null],
      },
    },
  };
}

function createFinalizedMdxBlock(status: "pending" | "compiled" | "error" = "pending"): Block {
  return {
    id: "mdx-block",
    type: "mdx",
    isFinalized: true,
    payload: {
      raw: "<Widget answer={42} />",
      meta: {
        mdxStatus: status,
      },
    },
  };
}

async function main() {
  const codeStore = createRendererStore([createFinalizedCodeBlock()]);
  const initialCode = codeStore.getNode("code-block");
  assert.ok(initialCode, "expected finalized code block");
  const initialCodeEpoch = initialCode.blockEpoch;

  const enrichedCodeBlock: Block = {
    ...initialCode.block!,
    payload: {
      ...initialCode.block!.payload,
      meta: {
        ...(initialCode.block!.payload.meta ?? {}),
        lazyTokenizedUntil: 1,
        highlightedLines: [
          '<span style="--shiki-dark:#F97583;--shiki-light:#D73A49">const</span><span style="--shiki-dark:#79B8FF;--shiki-light:#005CC5"> answer</span><span style="--shiki-dark:#F97583;--shiki-light:#D73A49"> =</span><span style="--shiki-dark:#79B8FF;--shiki-light:#005CC5"> 42</span><span style="--shiki-dark:#E1E4E8;--shiki-light:#24292E">;</span>',
        ],
      },
    },
  };

  codeStore.applyPatches([
    {
      op: "setProps",
      at: { blockId: "code-block", nodeId: "code-block" },
      props: {
        block: enrichedCodeBlock,
      },
      meta: {
        kind: "enrichment",
      },
    } satisfies Patch,
  ]);

  const enrichedCode = codeStore.getNode("code-block");
  assert.ok(enrichedCode, "expected finalized code block after enrichment");
  assert.strictEqual(enrichedCode.block?.isFinalized, true, "enrichment must not reopen finalized code blocks");
  assert.strictEqual(enrichedCode.blockEpoch, initialCodeEpoch, "enrichment must not advance finalized block epoch");
  assert.strictEqual(
    enrichedCode.block?.payload.meta?.lazyTokenizedUntil,
    1,
    "enrichment should update finalized lazy tokenization metadata",
  );

  const mdxStore = createRendererStore([createFinalizedMdxBlock()]);
  const initialMdx = mdxStore.getNode("mdx-block");
  assert.ok(initialMdx, "expected finalized mdx block");
  const initialMdxEpoch = initialMdx.blockEpoch;

  const staleCompiledMdx: Block = {
    ...initialMdx.block!,
    payload: {
      ...initialMdx.block!.payload,
      compiledMdxRef: { id: "compiled:stale" },
      meta: {
        ...(initialMdx.block!.payload.meta ?? {}),
        mdxStatus: "compiled",
      },
    },
  };

  mdxStore.applyPatches([
    {
      op: "setProps",
      at: { blockId: "mdx-block", nodeId: "mdx-block" },
      props: {
        block: staleCompiledMdx,
      },
      meta: {
        kind: "semantic",
        blockEpoch: initialMdxEpoch - 1,
      },
    } satisfies Patch,
  ]);

  const afterStale = mdxStore.getNode("mdx-block");
  assert.ok(afterStale, "expected finalized mdx block after stale semantic patch");
  assert.strictEqual(afterStale.block?.payload.meta?.mdxStatus, "pending", "stale semantic patch must be rejected");
  assert.strictEqual(afterStale.block?.payload.compiledMdxRef, undefined, "stale semantic patch must not land");

  const validCompiledMdx: Block = {
    ...afterStale.block!,
    payload: {
      ...afterStale.block!.payload,
      compiledMdxRef: { id: "compiled:ok" },
      meta: {
        ...(afterStale.block!.payload.meta ?? {}),
        mdxStatus: "compiled",
      },
    },
  };

  mdxStore.applyPatches([
    {
      op: "setProps",
      at: { blockId: "mdx-block", nodeId: "mdx-block" },
      props: {
        block: validCompiledMdx,
      },
      meta: {
        kind: "semantic",
        blockEpoch: initialMdxEpoch,
        parseEpoch: initialMdxEpoch + 1,
        tx: 404,
      },
    } satisfies Patch,
  ]);

  const compiledMdx = mdxStore.getNode("mdx-block");
  assert.ok(compiledMdx, "expected finalized mdx block after valid semantic update");
  assert.strictEqual(compiledMdx.block?.isFinalized, true, "valid semantic follow-up must keep block finalized");
  assert.strictEqual(compiledMdx.block?.payload.meta?.mdxStatus, "compiled", "valid semantic update should land");
  assert.strictEqual(compiledMdx.block?.payload.compiledMdxRef?.id, "compiled:ok", "compiled ref should land");
  assert.ok(compiledMdx.blockEpoch > initialMdxEpoch, "valid semantic follow-up should advance block epoch");

  const compiledEpoch = compiledMdx.blockEpoch;
  const staleErroredMdx: Block = {
    ...compiledMdx.block!,
    payload: {
      ...compiledMdx.block!.payload,
      compiledMdxRef: undefined,
      meta: {
        ...(compiledMdx.block!.payload.meta ?? {}),
        mdxStatus: "error",
        mdxError: "stale error",
      },
    },
  };

  mdxStore.applyPatches([
    {
      op: "setProps",
      at: { blockId: "mdx-block", nodeId: "mdx-block" },
      props: {
        block: staleErroredMdx,
      },
      meta: {
        kind: "semantic",
        blockEpoch: compiledEpoch - 1,
      },
    } satisfies Patch,
  ]);

  const afterStaleError = mdxStore.getNode("mdx-block");
  assert.ok(afterStaleError, "expected finalized mdx block after stale semantic error patch");
  assert.strictEqual(afterStaleError.block?.payload.meta?.mdxStatus, "compiled", "stale semantic error patch must be rejected");
  assert.strictEqual(afterStaleError.block?.payload.compiledMdxRef?.id, "compiled:ok", "stale semantic error patch must not clear compiled ref");

  const validErroredMdx: Block = {
    ...afterStaleError.block!,
    payload: {
      ...afterStaleError.block!.payload,
      compiledMdxRef: undefined,
      meta: {
        ...(afterStaleError.block!.payload.meta ?? {}),
        mdxStatus: "error",
        mdxError: "compile failed",
      },
    },
  };

  mdxStore.applyPatches([
    {
      op: "setProps",
      at: { blockId: "mdx-block", nodeId: "mdx-block" },
      props: {
        block: validErroredMdx,
      },
      meta: {
        kind: "semantic",
        blockEpoch: compiledEpoch,
        parseEpoch: compiledEpoch + 1,
        tx: 405,
      },
    } satisfies Patch,
  ]);

  const erroredMdx = mdxStore.getNode("mdx-block");
  assert.ok(erroredMdx, "expected finalized mdx block after valid semantic error update");
  assert.strictEqual(erroredMdx.block?.isFinalized, true, "valid semantic error follow-up must keep block finalized");
  assert.strictEqual(erroredMdx.block?.payload.meta?.mdxStatus, "error", "valid semantic error update should land");
  assert.strictEqual(erroredMdx.block?.payload.compiledMdxRef, undefined, "error transition should clear compiled ref");
  assert.ok(erroredMdx.blockEpoch > compiledEpoch, "valid semantic error follow-up should advance block epoch");

  const counters = mdxStore.getDebugCounters();
  assert.strictEqual(counters.staleEpochRejected, 2, "expected stale finalized semantic updates to be rejected twice");
}

await main();
console.log("post-finalize-store-boundary test passed");
