import assert from "node:assert";

import type { Block } from "@stream-mdx/core";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";

import { ComponentRegistry } from "../src/components";
import { BlockNodeRenderer } from "../src/renderer/node-views";
import { createRendererStore } from "../src/renderer/store";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function setupDom() {
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
  return window;
}

async function runMermaidRoutingTest(): Promise<void> {
  const window = await setupDom();

  const Mermaid = ({ code }: { code: string }) => React.createElement("div", { id: "mermaid" }, code);
  const registry = new ComponentRegistry({ mermaid: Mermaid as any });

  // Mermaid code fence should route to registry.mermaid and receive stripped code (no fences).
  const mermaidBlock: Block = {
    id: "code-mermaid",
    type: "code",
    isFinalized: false,
    payload: {
      raw: "```mermaid\ngraph TD; A-->B;\n```",
      meta: { lang: "mermaid" },
    },
  };

  const store = createRendererStore([mermaidBlock]);
  const container = window.document.getElementById("root");
  assert.ok(container, "missing test root container");
  const root = createRoot(container);
  root.render(React.createElement(BlockNodeRenderer, { store, blockId: mermaidBlock.id, registry }));
  await sleep(30);

  assert.ok(container.querySelector("#mermaid"), "expected mermaid block component to render");
  assert.ok(container.textContent?.includes("graph TD"), "expected stripped mermaid code to be passed through");
  assert.ok(!container.textContent?.includes("```mermaid"), "expected code fences to be stripped before rendering");
  assert.strictEqual(container.querySelector("pre"), null, "expected mermaid block not to be wrapped in the standard code <pre> frame");

  root.unmount();

  // Non-mermaid languages should render as normal code blocks even if registry has a mermaid component registered.
  const window2 = await setupDom();
  const block: Block = {
    id: "code-ts",
    type: "code",
    isFinalized: true,
    payload: {
      raw: "```ts\nconsole.log(1)\n```",
      meta: { lang: "ts" },
    },
  };
  const store2 = createRendererStore([block]);
  const container2 = window2.document.getElementById("root");
  assert.ok(container2, "missing second test root container");
  const root2 = createRoot(container2);
  root2.render(React.createElement(BlockNodeRenderer, { store: store2, blockId: block.id, registry }));
  await sleep(30);

  assert.strictEqual(container2.querySelector("#mermaid"), null, "did not expect mermaid component for non-mermaid language");
  assert.ok(container2.querySelector("pre"), "expected standard code <pre> wrapper for non-mermaid code blocks");

  root2.unmount();
}

await runMermaidRoutingTest();
console.log("mermaid routing test passed");

