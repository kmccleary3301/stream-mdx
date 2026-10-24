import assert from "node:assert/strict";
import { Worker as NodeWorker } from "node:worker_threads";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { StreamingMarkdown } from "../src";
import { workerFactory as createNativeWorker } from "./trusted-native-fixture";

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const codeLines = Array.from({ length: 40 }, (_, index) => `const sourceLine${index} = ${index};`);
const authoredCode = `${codeLines.join("\r\n")}\r\n`;
const markdown = `\`\`\`ts\r\n${authoredCode}\`\`\``;
const expectedSelection = codeLines.slice(1, 4).join("\r\n");

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) {
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 10)));
  }
  assert.ok(predicate(), "the public code viewport did not mount its source rows");
}

async function run(): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
  const { window } = dom;
  const keys = ["window", "document", "navigator", "HTMLElement", "Node", "Worker", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as Record<
    (typeof keys)[number],
    PropertyDescriptor | undefined
  >;
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    Worker: NodeWorker,
    ResizeObserver: ResizeObserverStub,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  let clipboardText: string | null = null;
  let downloadedBlob: Blob | null = null;
  let downloadName: string | null = null;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalAnchorClick = window.HTMLAnchorElement.prototype.click;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      downloadedBlob = blob;
      return "blob:p4-viewport";
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
  window.HTMLAnchorElement.prototype.click = function () {
    downloadName = this.download;
  };

  try {
    await act(async () => {
      root.render(React.createElement(StreamingMarkdown, {
        text: markdown,
        worker: createNativeWorker,
        engine: "worker",
        controls: { code: { copy: true, download: true } },
        codeVirtualization: { enabled: true, virtualizeThreshold: 5, windowSize: 20, bufferSize: 4 },
        caret: false,
      }));
    });
    await waitFor(() => Boolean(container.querySelector('[data-code-virtualized="true"] .line[data-line="4"]')));
    const firstRow = container.querySelector<HTMLElement>('.line[data-line="2"]');
    const lastRow = container.querySelector<HTMLElement>('.line[data-line="4"]');
    assert.ok(firstRow && lastRow);
    const firstText = window.document.createTreeWalker(firstRow, window.NodeFilter.SHOW_TEXT).nextNode() as Text | null;
    const lastWalker = window.document.createTreeWalker(lastRow, window.NodeFilter.SHOW_TEXT);
    let lastText: Text | null = null;
    while (lastWalker.nextNode()) lastText = lastWalker.currentNode as Text;
    assert.ok(firstText && lastText);
    const selection = window.getSelection();
    assert.ok(selection);
    const range = window.document.createRange();
    range.setStart(firstText, 0);
    range.setEnd(lastText, lastText.length);
    selection.removeAllRanges();
    selection.addRange(range);
    const clipboardData = { setData: (_type: string, value: string) => { clipboardText = value; } };
    const copyEvent = new window.Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copyEvent, "clipboardData", { value: clipboardData });
    lastRow.dispatchEvent(copyEvent);
    assert.equal(copyEvent.defaultPrevented, true, "native selection copy is handled at the code viewport");
    assert.equal(clipboardText, expectedSelection, "copy preserves the exact selected CRLF source across rows");
    const thirdRow = container.querySelector<HTMLElement>('.line[data-line="3"]');
    assert.ok(thirdRow);
    const newlineNode = thirdRow.nextSibling;
    assert.ok(newlineNode?.nodeType === window.Node.TEXT_NODE, "line spans have a standalone newline text node between them");
    const newlineRange = window.document.createRange();
    newlineRange.setStart(firstText, 0);
    newlineRange.setEnd(newlineNode, newlineNode.textContent?.length ?? 0);
    selection.removeAllRanges();
    selection.addRange(newlineRange);
    clipboardText = null;
    const newlineCopyEvent = new window.Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(newlineCopyEvent, "clipboardData", { value: clipboardData });
    thirdRow.dispatchEvent(newlineCopyEvent);
    assert.equal(newlineCopyEvent.defaultPrevented, true, "copy handles a selection ending in the newline text node");
    assert.equal(clipboardText, `${codeLines[1]}\r\n${codeLines[2]}\r\n`,
      "the selected standalone line break maps to the authored CRLF separator");


    const downloadButton = container.querySelector<HTMLButtonElement>('button[data-stream-mdx-action="download"]');
    assert.ok(downloadButton);
    await act(async () => downloadButton.click());
    assert.equal(downloadName, "snippet.ts");
    assert.ok(downloadedBlob, "the public download action must create a Blob");
    assert.deepEqual(Buffer.from(await downloadedBlob.arrayBuffer()), Buffer.from(authoredCode));
  } finally {
    await act(async () => root.unmount());
    window.HTMLAnchorElement.prototype.click = originalAnchorClick;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectURL });
    for (const key of keys) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

await run();
console.log("native code selected-copy and source-download test passed");
