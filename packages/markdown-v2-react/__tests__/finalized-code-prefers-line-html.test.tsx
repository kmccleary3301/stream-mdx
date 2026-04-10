import assert from "node:assert";

import type { Block } from "@stream-mdx/core";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";

import { ComponentRegistry } from "../src/components";
import { BlockNodeRenderer } from "../src/renderer/node-views";
import { createRendererStore } from "../src/renderer/store";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  (globalThis as any).window = window;
  (globalThis as any).document = window.document;
  (globalThis as any).HTMLElement = window.HTMLElement;
  (globalThis as any).Node = window.Node;
  (globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
  (globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

  const block: Block = {
    id: "code-block",
    type: "code",
    isFinalized: true,
    payload: {
      raw: ["```text", "Stability note:", "```"].join("\n"),
      highlightedHtml:
        '<pre class="shiki shiki-themes github-dark github-light" tabindex="undefined"><code><span class="line"><span>legacy-block-html</span></span></code></pre>',
      meta: {
        lang: "text",
        code: "Stability note:",
        highlightedLines: ['<span>Stability note:</span>'],
      },
    },
  };

  const store = createRendererStore([block]);
  const registry = new ComponentRegistry();
  const container = window.document.getElementById("root");
  assert.ok(container, "missing test root container");

  const root = createRoot(container);
  root.render(React.createElement(BlockNodeRenderer, { store, blockId: block.id, registry }));
  await sleep(30);

  const html = container.innerHTML;
  assert.ok(html.includes('data-line="1"'), "expected finalized code to be composed from line nodes");
  assert.ok(html.includes("Stability note:"), "expected composed line html content");
  assert.ok(!html.includes("legacy-block-html"), "expected stale block-level highlightedHtml to be ignored when line html exists");
  assert.ok(!html.includes('tabindex="undefined"'), "expected normalized wrapper attrs from composed line html");

  root.unmount();
}

await main();
console.log("finalized-code-prefers-line-html test passed");
