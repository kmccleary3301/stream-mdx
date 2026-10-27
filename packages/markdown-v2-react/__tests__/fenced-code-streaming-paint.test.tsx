import assert from "node:assert/strict";

import { PATCH_ROOT_ID, STREAM_MDX_SCHEMA_VERSION, type WorkerIn, type WorkerOut } from "@stream-mdx/core";
import { createInlineEngineWorker } from "@stream-mdx/worker/engine";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ComponentRegistry } from "../src/components";
import { BlockNodeRenderer } from "../src/renderer/node-views";
import { createRendererStore } from "../src/renderer/store";
import { useVirtualizedCode } from "../src/renderer/virtualized-code";

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

function VirtualizedCodeProbe({
  totalLines,
  generation,
  ownerIdentity,
}: {
  totalLines: number;
  generation: number;
  ownerIdentity: object;
}) {
  const virtualization = useVirtualizedCode(
    totalLines,
    generation,
    { enabled: true, windowSize: 20, bufferSize: 5, virtualizeThreshold: 2, followTail: true },
    "probe-code",
    0,
    ownerIdentity,
  );
  const rows = virtualization.renderRanges.flatMap((range) =>
    Array.from({ length: range.endIndex - range.startIndex }, (_, index) => {
      const lineNumber = range.startIndex + index + 1;
      return React.createElement(
        "div",
        { key: lineNumber, className: "line", "data-line": String(lineNumber) },
        `probeLine${lineNumber}`,
      );
    }),
  );
  return React.createElement(
    "div",
    { "data-code-block": "true", "data-code-total-lines": String(totalLines) },
    React.createElement(
      "div",
      {
        ref: virtualization.containerRef,
        className: "markdown-code-block-container",
        onScroll: virtualization.handleScroll,
      },
      React.createElement("div", { style: { height: `${virtualization.spacerTopHeight}px` }, "aria-hidden": true }),
      ...rows,
      React.createElement("div", { style: { height: `${virtualization.spacerBottomHeight}px` }, "aria-hidden": true }),
    ),
  );
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
    const ownerIdentity = {};
    const probeRoot = createRoot(container);
    root.current = probeRoot;
    try {
      await act(async () => {
        probeRoot.render(React.createElement(VirtualizedCodeProbe, { totalLines: 210, generation: 1, ownerIdentity }));
      });
      await flushRendererFrame();
      const probeViewport = container.querySelector<HTMLElement>(".markdown-code-block-container");
      const probeOwner = container.querySelector<HTMLElement>('[data-code-block="true"]');
      assert.ok(probeViewport);
      assert.ok(probeOwner);
      const priorBottom = probeViewport.scrollHeight - probeViewport.clientHeight;
      probeOwner.setAttribute("data-code-total-lines", "211");
      await act(async () => {
        probeViewport.scrollTop = priorBottom - 170;
        probeViewport.dispatchEvent(new window.Event("scroll", { bubbles: true }));
      });
      await flushRendererFrame();
      assert.equal(
        probeViewport.scrollTop,
        probeViewport.scrollHeight - probeViewport.clientHeight,
        "content growth must not detach an opt-in code window after a geometry-induced upward scroll",
      );
      await act(async () => {
        probeRoot.render(React.createElement(VirtualizedCodeProbe, { totalLines: 211, generation: 2, ownerIdentity }));
      });
      await flushRendererFrame();
      await flushRendererFrame();
      assert.equal(
        probeViewport.scrollTop,
        probeViewport.scrollHeight - probeViewport.clientHeight,
        "an opt-in code window should stay at the tail when its source generation changes",
      );
      assert.ok(
        container.querySelector('.line[data-line="211"]'),
        "the newest row should remain mounted after a streaming owner refresh",
      );
    } finally {
      await act(async () => probeRoot.unmount());
      root.current = null;
    }
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
    const initialCodePrefix = "const streamLine0";
    await sendUntil(
      { type: "APPEND", text: `\`\`\`ts\n${initialCodePrefix}` },
      () => store.getChildren(PATCH_ROOT_ID).some((id) => store.getCodeBlock(id) !== undefined),
    );
    const findCodeBlockId = (): string | undefined =>
      store.getChildren(PATCH_ROOT_ID).find((id) => store.getCodeBlock(id) !== undefined);
    let blockId = findCodeBlockId();
    assert.ok(blockId, "worker should publish the open fenced code owner");
    assert.equal(store.getCodeBlock(blockId)?.source.state, "open");

    await act(async () => {
      const rendererRoot = createRoot(container);
      root.current = rendererRoot;
      rendererRoot.render(React.createElement(BlockNodeRenderer, { store, blockId, registry }));
    });
    await flushRendererFrame();

    const remainingCode = `${initialLines[0].slice(initialCodePrefix.length)}\n${initialLines.slice(1).join("\n")}\n`;
    await sendUntil({ type: "APPEND", text: remainingCode }, () => {
      const currentBlockId = findCodeBlockId();
      return currentBlockId !== undefined && store.getCodeBlock(currentBlockId)?.source.lineCount === 210;
    });
    const grownBlockId = findCodeBlockId();
    assert.ok(grownBlockId, "the open code owner should remain published while growing");
    blockId = grownBlockId;
    await act(async () => {
      root.current?.render(React.createElement(BlockNodeRenderer, { store, blockId, registry }));
    });
    await flushRendererFrame();

    let viewport = container.querySelector<HTMLElement>(".markdown-code-block-container");
    assert.ok(viewport, "followTail should retain the virtualized code viewport");
    assert.equal(
      viewport.scrollTop,
      viewport.scrollHeight - viewport.clientHeight,
      "followTail should keep the growing open code viewport at its tail across an owner refresh",
    );
    assert.ok(
      container.textContent?.includes(initialLines[209]),
      "the latest line from an owner refresh should be visible in the virtualized window",
    );
    const appendedLine = "const streamLine210 = 210;";
    await sendUntil({ type: "APPEND", text: `${appendedLine}\n` }, () => {
      const currentBlockId = findCodeBlockId();
      return currentBlockId !== undefined && store.getCodeLines(currentBlockId, 210, 211)[0]?.text === appendedLine;
    });
    const appendedBlockId = findCodeBlockId();
    assert.ok(appendedBlockId);
    blockId = appendedBlockId;
    await act(async () => {
      root.current?.render(React.createElement(BlockNodeRenderer, { store, blockId, registry }));
    });
    await flushRendererFrame();
    viewport = container.querySelector<HTMLElement>(".markdown-code-block-container");
    assert.ok(viewport, "the appended open code block should retain its viewport");

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
