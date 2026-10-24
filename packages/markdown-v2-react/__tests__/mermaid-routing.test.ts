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
  const MermaidPresentation = ({ actions, children, metadata }: {
    actions: { readSource: () => string };
    children: React.ReactNode;
    metadata: { language?: string };
  }) => {
    if (metadata.language?.toLowerCase() !== "mermaid") return children;
    return React.createElement("div", { id: "mermaid" }, actions.readSource());
  };
  const registry = new ComponentRegistry({
    components: { code: { wrapper: MermaidPresentation } },
  });
  // The consumer reads the authored Mermaid source through the generation-bound action.
  const mermaidBlock: Block = {
    id: "code-mermaid",
    type: "code",
    isFinalized: false,
    payload: {
      raw: "```mermaid\ngraph TD; A-->B;\n```",
      meta: { lang: "mermaid", code: "graph TD; A-->B;" },
    },
  };

  const store = createRendererStore([mermaidBlock]);
  const container = window.document.getElementById("root");
  assert.ok(container, "missing test root container");
  const root = createRoot(container);
  root.render(React.createElement(BlockNodeRenderer, { store, blockId: mermaidBlock.id, registry }));
  await sleep(30);

  assert.ok(container.querySelector("#mermaid"), "expected mermaid block component to render");
  assert.strictEqual(
    container.textContent,
    mermaidBlock.payload.raw,
    "expected authored Mermaid Markdown to be passed through",
  );
  assert.strictEqual(container.querySelector("pre"), null, "expected Mermaid presentation to replace the standard code view");

  root.unmount();

  // Non-Mermaid languages preserve the native code view.
  const window2 = await setupDom();
  const block: Block = {
    id: "code-ts",
    type: "code",
    isFinalized: true,
    payload: {
      raw: "```ts\nconsole.log(1)\n```",
      meta: { lang: "ts", code: "console.log(1)" },
    },
  };
  const store2 = createRendererStore([block]);
  const container2 = window2.document.getElementById("root");
  assert.ok(container2, "missing second test root container");
  const root2 = createRoot(container2);
  root2.render(React.createElement(BlockNodeRenderer, { store: store2, blockId: block.id, registry }));
  await sleep(30);

  assert.strictEqual(container2.querySelector("#mermaid"), null, "did not expect Mermaid presentation for non-Mermaid language");
  assert.ok(container2.querySelector("pre"), "expected standard code <pre> wrapper for non-Mermaid code blocks");

  root2.unmount();
}

await runMermaidRoutingTest();
console.log("mermaid presentation routing test passed");


