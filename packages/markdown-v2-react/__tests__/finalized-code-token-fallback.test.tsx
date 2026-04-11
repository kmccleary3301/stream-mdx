import assert from "node:assert";

import type { Block, TokenLineV1 } from "@stream-mdx/core";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";

import { ComponentRegistry } from "../src/components";
import { BlockNodeRenderer } from "../src/renderer/node-views";
import { createRendererStore } from "../src/renderer/store";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function tokenSpan(text: string, fg: string): TokenLineV1 {
  return {
    spans: [{ t: text, v: { dark: { fg }, light: { fg } } }],
  };
}

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
      raw: ["```js", "const a = 1;", "console.log(a);", "```"].join("\n"),
      highlightedHtml: undefined,
      meta: {
        lang: "javascript",
        code: ["const a = 1;", "console.log(a);"].join("\n"),
        highlightedLines: ['<span style="--shiki-dark:#F97583;--shiki-light:#D73A49">const a = 1;</span>', null],
        tokenLines: [tokenSpan("const a = 1;", "#F97583"), {
          spans: [
            { t: "console.", v: { dark: { fg: "#E1E4E8" }, light: { fg: "#24292E" } } },
            { t: "log", v: { dark: { fg: "#B392F0" }, light: { fg: "#6F42C1" } } },
            { t: "(a);", v: { dark: { fg: "#E1E4E8" }, light: { fg: "#24292E" } } },
          ],
        }],
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
  assert.ok(
    html.includes('<span class="line" data-line="2"><span style="--shiki-dark:#E1E4E8;--shiki-light:#24292E">console.</span><span style="--shiki-dark:#B392F0;--shiki-light:#6F42C1">log</span><span style="--shiki-dark:#E1E4E8;--shiki-light:#24292E">(a);</span></span>'),
    "expected finalized token fallback to render deterministic highlighted html for the missing line",
  );
  assert.ok(!html.includes('<span class="line" data-line="2">console.log(a);</span>'), "expected plain-text fallback to be bypassed when token spans exist");

  root.unmount();
}

await main();
console.log("finalized-code-token-fallback test passed");
