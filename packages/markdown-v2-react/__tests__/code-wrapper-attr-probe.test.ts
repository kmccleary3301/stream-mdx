import assert from "node:assert";

import type { Block } from "@stream-mdx/core";

import { createRendererStore } from "../src/renderer/store";

function main(): void {
  const repeated = "const value = 1;\n".repeat(400);
  const highlightedHtml = [
    '<pre class="shiki shiki-themes github-dark github-light" data-language="ts" style="--shiki-dark-bg: transparent; --shiki-light-bg: transparent">',
    '<code data-language="ts" data-theme="github-dark github-light" style="display: grid;">',
    repeated,
    "</code>",
    "</pre>",
  ].join("");

  const block: Block = {
    id: "code-block",
    type: "code",
    isFinalized: true,
    payload: {
      raw: repeated,
      highlightedHtml,
      meta: { lang: "ts" },
    },
  };

  const store = createRendererStore([block]);
  const node = store.getNode(block.id);
  assert.ok(node, "expected code block node");
  assert.strictEqual(node?.type, "code");
  assert.strictEqual(node?.props?.lang, "ts");
  assert.strictEqual(node?.props?.preAttrs?.["data-language"], "ts");
  assert.strictEqual(node?.props?.codeAttrs?.["data-language"], "ts");
  assert.strictEqual(node?.props?.codeAttrs?.["data-theme"], "github-dark github-light");
}

main();
console.log("code-wrapper-attr-probe test passed");
