import assert from "node:assert/strict";

import { PATCH_ROOT_ID, STREAM_MDX_SCHEMA_VERSION, type Patch, type WorkerOut } from "@stream-mdx/core";
import { createInlineEngineWorker } from "@stream-mdx/worker/engine";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ComponentRegistry } from "../src/components";
import { BlockNodeRenderer } from "../src/renderer/node-views";
import { createRendererStore, type RendererStore } from "../src/renderer/store";

function currentCodeOwnerId(store: RendererStore): string | null {
  for (const childId of store.getNode(PATCH_ROOT_ID)?.children ?? []) {
    if (store.getCodeBlock(childId)) return childId;
  }
  return null;
}
function assertMountedCodeLineOrder(container: Element, firstLine: string, appendedLine: string): void {
  const renderedCode = container.querySelector("pre code");
  assert.ok(renderedCode, "native code presentation should render semantic code content");
  const renderedSource = renderedCode.textContent ?? "";
  const firstLinePosition = renderedSource.indexOf(firstLine);
  const appendedLinePosition = renderedSource.indexOf(appendedLine);
  assert.notEqual(firstLinePosition, -1, "mounted code should contain the first authored line");
  assert.notEqual(appendedLinePosition, -1, "mounted code should contain the appended authored line");
  assert.ok(firstLinePosition < appendedLinePosition, "mounted code should preserve authored line order");
}

async function flushRendererFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}


async function runNativeCodeLineUpdateTest(): Promise<void> {
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

  const store = createRendererStore();
  const registry = new ComponentRegistry();
  const root: { current: Root | null } = { current: null };
  try {
    const container = window.document.getElementById("root");
    assert.ok(container, "missing test root container");

    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WorkerOut>) => {
        const message = event.data;
        if (message.type === "INITIALIZED") {
          store.resetSnapshot(message.snapshot);
          resolve();
        } else if (message.type === "ERROR") {
          reject(new Error(message.error.message));
        }
      };
      worker.postMessage({
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
      });
    });

    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WorkerOut>) => {
        const message = event.data;
        if (message.type === "PATCH") {
          act(() => store.applyPatches(message.patches));
          const blockId = currentCodeOwnerId(store);
          if (blockId && store.getCodeLines(blockId, 0, 1)[0]?.text === "const before = 1;") {
            resolve();
          }
        } else if (message.type === "ERROR") {
          reject(new Error(message.error.message));
        }
      };
      worker.postMessage({ type: "APPEND", text: "```ts\nconst before = 1;\n" });
    });

    const blockId = currentCodeOwnerId(store);
    assert.ok(blockId, "inline engine should publish a native code owner");
    const firstRecord = store.getCodeLines(blockId, 0, 1)[0];
    assert.ok(firstRecord, "native code owner should expose its first source line");
    assert.equal(firstRecord.text, "const before = 1;");
    assert.equal(firstRecord.ending, "\n", "the authored line ending belongs to the native source record");

    await act(async () => {
      const rendererRoot = createRoot(container);
      root.current = rendererRoot;
      rendererRoot.render(React.createElement(BlockNodeRenderer, { store, blockId, registry }));
    });
    assert.ok(
      container.textContent?.includes("const before = 1;"),
      "native code row should render the initial authored source",
    );

    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WorkerOut>) => {
        const message = event.data;
        if (message.type === "PATCH") {
          act(() => store.applyPatches(message.patches));
        } else if (message.type === "FINALIZED") {
          resolve();
        } else if (message.type === "ERROR") {
          reject(new Error(message.error.message));
        }
      };
      worker.postMessage({ type: "APPEND", text: "const after = 2;\n```" });
      worker.postMessage({ type: "FINALIZE" });
    });
    await flushRendererFrame();

    const lines = store.getCodeLines(blockId, 0, 2);
    assert.deepEqual(
      lines.map((line) => line.text),
      ["const before = 1;", "const after = 2;"],
      "native source records should preserve both authored lines",
    );
    assert.equal(lines[0]?.ending, "\n", "native source should retain the newline between authored lines");
    assertMountedCodeLineOrder(container, "const before = 1;", "const after = 2;");

    let highlightPatch: Extract<Patch, { op: "decorateCode" }> | null = null;
    const readHighlightPatch = (): Extract<Patch, { op: "decorateCode" }> | null => highlightPatch;
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WorkerOut>) => {
        const message = event.data;
        if (message.type === "PATCH") {
          act(() => store.applyPatches(message.patches));
          const decoration = message.patches.find(
            (patch): patch is Extract<Patch, { op: "decorateCode" }> => patch.op === "decorateCode",
          );
          if (decoration) {
            highlightPatch = decoration;
            resolve();
          }
        } else if (message.type === "ERROR") {
          reject(new Error(message.error.message));
        }
      };
      worker.postMessage({
        type: "TOKENIZE_RANGE",
        blockId,
        startLine: 0,
        endLine: lines.length,
        priority: "visible",
      });
    });
    await flushRendererFrame();
    const actualDecorationPatch = readHighlightPatch();
    assert.ok(actualDecorationPatch, "worker should supply a decoration with its real owner and source revisions");
    assert.ok(
      container.querySelector("pre code span[style]"),
      "real worker decoration should render styled native token spans",
    );

    const clearDecorationPatch: Extract<Patch, { op: "decorateCode" }> = {
      ...actualDecorationPatch,
      decorations: actualDecorationPatch.decorations.map((decoration) => ({
        index: decoration.index,
        lineId: decoration.lineId,
        sourceRevision: decoration.sourceRevision,
        configurationRevision: decoration.configurationRevision,
        tokens: null,
      })),
    };
    act(() => store.applyPatches([clearDecorationPatch], { captureMetrics: false }));
    await flushRendererFrame();
    assert.equal(
      container.querySelector("pre code span[style]"),
      null,
      "a valid owner-matched decoration clear should remove native token styles",
    );
    assert.ok(
      store.getCodeLines(blockId, 0, lines.length).every((line) => line.decoration === undefined),
      "clearing decorations should leave the native source records intact",
    );
    assertMountedCodeLineOrder(container, "const before = 1;", "const after = 2;");
  } finally {
    try {
      if (root.current) act(() => root.current?.unmount());
    } finally {
      try {
        worker.terminate();
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

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

await runNativeCodeLineUpdateTest();
console.log("code-block-line-update test passed");
