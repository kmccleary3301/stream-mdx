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

}

await main();
console.log("post-finalize-store-boundary test passed");
