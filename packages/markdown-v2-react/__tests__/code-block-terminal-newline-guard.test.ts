import assert from "node:assert";

import type { Block, Patch } from "@stream-mdx/core";
import React from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";

import { ComponentRegistry } from "../src/components";
import { BlockNodeRenderer } from "../src/renderer/node-views";
import { createRendererStore } from "../src/renderer/store";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

async function runCodeBlockTerminalNewlineGuardTest(): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  (globalThis as any).window = window;
  (globalThis as any).document = window.document;
  (globalThis as any).HTMLElement = window.HTMLElement;
  (globalThis as any).Node = window.Node;
  (globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
  (globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  (globalThis as any).ResizeObserver = ResizeObserverStub;

  const initialCode = "alpha\nbeta";
  const staleParentCode = "alpha\nbeta\n";
  const partialLine = "gam";
  const block: Block = {
    id: "code-terminal-newline-guard",
    type: "code",
    isFinalized: false,
    payload: {
      raw: `\`\`\`txt\n${initialCode}`,
      meta: {
        lang: "txt",
        code: initialCode,
      },
    },
  };

  const store = createRendererStore([block]);
  const registry = new ComponentRegistry();

  const patches: Patch[] = [
    {
      op: "setProps",
      at: { blockId: block.id, nodeId: block.id },
      props: {
        block: {
          ...block,
          payload: {
            ...block.payload,
            raw: `\`\`\`txt\n${staleParentCode}`,
            meta: {
              ...(block.payload.meta ?? {}),
              code: staleParentCode,
            },
          },
        },
      },
    },
    {
      op: "appendLines",
      at: { blockId: block.id, nodeId: block.id },
      startIndex: 2,
      lines: [partialLine],
      highlight: [null],
    },
  ];
  store.applyPatches(patches);

  const container = window.document.getElementById("root");
  assert.ok(container, "missing test root container");
  const root = createRoot(container);
  root.render(React.createElement(BlockNodeRenderer, { store, blockId: block.id, registry }));
  await sleep(40);

  const code = container.querySelector('pre[data-code-block="true"] code') as HTMLElement | null;
  assert.ok(code, "expected rendered code element");
  assert.strictEqual(code.textContent, "alpha\nbeta\ngam", "renderer must not synthesize a premature trailing newline");

  root.unmount();
}

runCodeBlockTerminalNewlineGuardTest()
  .then(() => {
    console.log("code-block-terminal-newline-guard test passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
