import assert from "node:assert/strict";

import { PATCH_ROOT_ID, STREAM_MDX_SCHEMA_VERSION, type WorkerIn, type WorkerOut } from "@stream-mdx/core";
import { createInlineEngineWorker } from "@stream-mdx/worker/engine";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ComponentRegistry } from "../src/components";
import { BlockNodeRenderer } from "../src/renderer/node-views";
import { createRendererStore } from "../src/renderer/store";

async function flushRendererFrame(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  await act(async () => {
    requestAnimationFrame(resolve);
    await promise;
  });
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

async function runFencedCodeStreamingPaintTest(): Promise<void> {
  const worker = createInlineEngineWorker();
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const globalKeys = [
    "window",
    "document",
    "HTMLElement",
    "Node",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "ResizeObserver",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const previousGlobals = Object.fromEntries(
    globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as Record<(typeof globalKeys)[number], PropertyDescriptor | undefined>;
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    ResizeObserver: ResizeObserverStub,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const previousClientHeight = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "clientHeight");
  const previousScrollHeight = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "scrollHeight");
  Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.matches(".markdown-code-block-container")) return 200;
      return previousClientHeight?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.matches(".markdown-code-block-container")) {
        const codeBlock = this.closest('[data-code-block="true"]');
        return Number(codeBlock?.getAttribute("data-code-total-lines") ?? "0") * 20;
      }
      return previousScrollHeight?.get?.call(this) ?? 0;
    },
  });

  const store = createRendererStore();
  const registry = new ComponentRegistry({ codeVirtualization: { followTail: true } });
  const root: { current: Root | null } = { current: null };
  const container = window.document.getElementById("root");
  assert.ok(container, "missing test root container");

  const sendUntil = (input: WorkerIn, done: () => boolean): Promise<void> => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    worker.onmessage = (event: MessageEvent<WorkerOut>) => {
      const message = event.data;
      if (message.type === "INITIALIZED") {
        store.resetSnapshot(message.snapshot);
      } else if (message.type === "PATCH") {
        act(() => store.applyPatches(message.patches));
      } else if (message.type === "ERROR") {
        reject(new Error(message.error.message));
        return;
      }
      if (done()) resolve();
    };
    worker.postMessage(input);
    return promise;
  };

  try {
    await sendUntil({
      type: "INIT",
      schemaVersion: STREAM_MDX_SCHEMA_VERSION,
      initialContent: "",
      prewarmLangs: [],
      docPlugins: {
        html: false,
        mdx: false,
        tables: false,
        math: false,
        outputMode: "html",
        lazyTokenization: { enabled: true, thresholdLines: 1 },
      },
    }, () => store.getNode(PATCH_ROOT_ID) !== undefined);

    const initialLines = Array.from({ length: 210 }, (_, index) => `const streamLine${index} = ${index};`);
    await sendUntil(
      { type: "APPEND", text: `\`\`\`ts\n${initialLines.join("\n")}\n` },
      () => store.getChildren(PATCH_ROOT_ID).some((id) => store.getCodeBlock(id) !== undefined),
    );
    const blockId = store.getChildren(PATCH_ROOT_ID).find((id) => store.getCodeBlock(id) !== undefined);
    assert.ok(blockId, "worker should publish the open fenced code owner");
    assert.equal(store.getCodeBlock(blockId)?.source.state, "open");

    await act(async () => {
      const rendererRoot = createRoot(container);
      root.current = rendererRoot;
      rendererRoot.render(React.createElement(BlockNodeRenderer, { store, blockId, registry }));
    });
    await flushRendererFrame();

    const viewport = container.querySelector<HTMLElement>(".markdown-code-block-container");
    assert.ok(viewport, "followTail should retain the virtualized code viewport");
    assert.equal(
      viewport.scrollTop,
      viewport.scrollHeight - viewport.clientHeight,
      "followTail should place a newly created open code viewport at its bottom",
    );
    const appendedLine = "const streamLine210 = 210;";
    await sendUntil({ type: "APPEND", text: `${appendedLine}\n` }, () =>
      store.getCodeLines(blockId, 210, 211)[0]?.text === appendedLine,
    );
    await flushRendererFrame();

    assert.equal(viewport.scrollTop, viewport.scrollHeight - viewport.clientHeight);
    assert.ok(
      container.textContent?.includes(appendedLine),
      "the latest appended fence line should be present in rendered text within one frame of its worker patch",
    );
    await sendUntil({ type: "FINALIZE" }, () =>
      store.getCodeBlock(blockId)?.source.state === "finalized",
    );
    await flushRendererFrame();
    assert.equal(
      container.querySelector("[data-code-block]")?.getAttribute("data-code-virtualized"),
      "true",
      "completed code should return to the configured virtualization window",
    );

  } finally {
    try {
      if (root.current) act(() => root.current?.unmount());
    } finally {
      try {
        worker.terminate();
          if (previousClientHeight) Object.defineProperty(window.HTMLElement.prototype, "clientHeight", previousClientHeight);
          else Reflect.deleteProperty(window.HTMLElement.prototype, "clientHeight");
          if (previousScrollHeight) Object.defineProperty(window.HTMLElement.prototype, "scrollHeight", previousScrollHeight);
          else Reflect.deleteProperty(window.HTMLElement.prototype, "scrollHeight");
      } finally {
        try {
          window.close();
        } finally {
          for (const key of globalKeys) {
            const descriptor = previousGlobals[key];
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
          }
        }
      }
    }
  }
}

await runFencedCodeStreamingPaintTest();
console.log("fenced-code-streaming-paint test passed");
