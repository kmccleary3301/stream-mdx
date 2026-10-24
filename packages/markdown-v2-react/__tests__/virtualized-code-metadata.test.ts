import assert from "node:assert";
import { Worker as NodeWorker } from "node:worker_threads";

import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { StreamingMarkdown, type StreamingMarkdownHandle } from "../src/index";
import { ViewportHeightIndex } from "../src/renderer/viewport-height-index";
import { workerFactory as createNativeWorker } from "./trusted-native-fixture";

class ResizeObserverStub implements ResizeObserver {
  private static readonly observers = new Set<ResizeObserverStub>();
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverStub.observers.add(this);
  }

  observe(target: Element, _options?: ResizeObserverOptions): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
    ResizeObserverStub.observers.delete(this);
  }

  static notify(target: Element, height: number): void {
    const size = { inlineSize: 0, blockSize: height } as ResizeObserverSize;
    const contentRect = {
      x: 0,
      y: 0,
      width: 0,
      height,
      top: 0,
      right: 0,
      bottom: height,
      left: 0,
    } as DOMRectReadOnly;
    const entry = {
      target,
      contentRect,
      borderBoxSize: [size],
      contentBoxSize: [size],
      devicePixelContentBoxSize: [size],
    } as ResizeObserverEntry;
    for (const observer of ResizeObserverStub.observers) {
      if (!observer.targets.has(target)) continue;
      observer.callback([entry], observer);
    }
  }
}

function getCodeSourceLineIndex(element: Element): number | null {
  if (!element.matches(".line[data-line]")) return null;
  const lineNumber = Number(element.getAttribute("data-line"));
  return Number.isSafeInteger(lineNumber) && lineNumber > 0 ? lineNumber - 1 : null;
}

function hasMountedCodeLine(container: Element, sourceLine: string): boolean {
  return Array.from(container.querySelectorAll<HTMLElement>(".line"))
    .some((line) => line.textContent === sourceLine);
}

async function waitForMountedCodeLine(container: Element, sourceLine: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!hasMountedCodeLine(container, sourceLine) && Date.now() < deadline) {
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
  }
  assert.ok(hasMountedCodeLine(container, sourceLine), `expected mounted authored code line: ${sourceLine}`);
}

function hasCodeLineCount(container: Element, lineCount: number): boolean {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-code-total-lines]"))
    .some((block) => block.getAttribute("data-code-total-lines") === String(lineCount));
}

async function waitForCodeLineCount(container: Element, lineCount: number): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!hasCodeLineCount(container, lineCount) && Date.now() < deadline) {
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
  }
  assert.ok(hasCodeLineCount(container, lineCount), `expected rendered code line count: ${lineCount}`);
}

async function waitForCodeViewportState(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!predicate() && Date.now() < deadline) {
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
  }
  assert.ok(predicate(), message);
}

function testViewportHeightIndex(): void {
  const index = new ViewportHeightIndex();
  assert.equal(index.indexAt(10), 0);
  index.reset(5, 10);
  assert.equal(index.offsetAt(0), 0);
  assert.equal(index.offsetAt(5), 50);
  assert.equal(index.offsetAt(2.9), 20);
  assert.equal(index.offsetAt(-1), 0);
  assert.equal(index.offsetAt(50), 50);
  assert.equal(index.offsetAt(Number.NaN), 0);
  assert.equal(index.offsetAt(Number.POSITIVE_INFINITY), 0);
  assert.equal(index.indexAt(Number.NaN), 0);
  assert.equal(index.indexAt(-1), 0);
  assert.equal(index.indexAt(10), 1);
  assert.equal(index.indexAt(50), 5);
  assert.equal(index.indexAt(Number.POSITIVE_INFINITY), 5);

  assert.equal(index.setHeight(-1, 12), false);
  assert.equal(index.setHeight(0.5, 12), false);
  assert.equal(index.setHeight(Number.MAX_SAFE_INTEGER + 1, 12), false);
  assert.equal(index.setHeight(5, 12), false);
  assert.equal(index.setHeight(0, 0), false);
  assert.equal(index.setHeight(0, -1), false);
  assert.equal(index.setHeight(0, Number.NaN), false);
  assert.equal(index.setHeight(0, Number.POSITIVE_INFINITY), false);
  assert.equal(index.setHeight(0, 10.5), false);
  assert.equal(index.setHeight(0, 10.6), true);
  assert.equal(index.offsetAt(1), 10.6);
  assert.equal(index.setHeight(0, 10.2), false);
  assert.equal(index.setHeight(0, 10), true);
  assert.equal(index.offsetAt(1), 10);

  assert.equal(index.setHeight(3, 25), true);
  assert.equal(index.setHeight(4, 5), true);
  assert.equal(index.offsetAt(3), 30);
  assert.equal(index.offsetAt(4), 55);
  assert.equal(index.offsetAt(5), 60);
  assert.equal(index.indexAt(29), 2);
  assert.equal(index.indexAt(30), 3);
  assert.equal(index.indexAt(54), 3);
  assert.equal(index.indexAt(55), 4);
  assert.equal(index.indexAt(60), 5);
  assert.equal(index.setHeight(3, 10), true);
  assert.equal(index.offsetAt(5), 45);
  assert.equal(index.indexAt(45), 5);
  index.resize(5);
  index.resize(8);
  assert.equal(index.offsetAt(8), 75);
  assert.equal(index.indexAt(74), 7);
  assert.equal(index.indexAt(75), 8);
  index.resize(3);
  assert.equal(index.offsetAt(3), 30);
  index.resize(5);
  assert.equal(index.offsetAt(5), 50);

  const shrinkIndex = new ViewportHeightIndex();
  shrinkIndex.reset(5, 10);
  assert.equal(shrinkIndex.setHeight(4, 5), true);
  shrinkIndex.resize(3);
  shrinkIndex.resize(5);
  assert.equal(shrinkIndex.offsetAt(5), 50);

  const growingIndex = new ViewportHeightIndex();
  growingIndex.reset(5, 10);
  assert.equal(growingIndex.setHeight(1, 15), true);
  assert.equal(growingIndex.setHeight(3, 20), true);
  growingIndex.resize(8);
  assert.equal(growingIndex.offsetAt(8), 95);

  const nonPowerOfTwoIndex = new ViewportHeightIndex();
  nonPowerOfTwoIndex.reset(8, 10);
  assert.equal(nonPowerOfTwoIndex.setHeight(2, 15), true);
  assert.equal(nonPowerOfTwoIndex.offsetAt(8), 85);

  index.reset(3.8, 8);
  assert.equal(index.offsetAt(3), 24);
  assert.equal(index.setHeight(1, 12), true);
  assert.equal(index.offsetAt(3), 28);
  index.reset(2, 0);
  assert.equal(index.offsetAt(2), 40);
  assert.equal(index.indexAt(20), 1);
  index.resize(Number.POSITIVE_INFINITY);
  assert.equal(index.offsetAt(1), 0);
  assert.equal(index.indexAt(20), 0);
  assert.equal(index.setHeight(0, 20), false);
  index.reset(-1, 10);
  assert.equal(index.offsetAt(1), 0);
  index.reset(Number.NaN, 10);
  assert.equal(index.indexAt(1), 0);
}

async function runStreamingCodeViewportTest(): Promise<void> {
  testViewportHeightIndex();
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const { window } = dom;
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    ResizeObserver: ResizeObserverStub,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const sourceLineHeights = Array.from({ length: 600 }, () => 20);
  const physicalMountedLineTop = (line: HTMLElement): number => {
    const lineViewport = line.closest<HTMLElement>(".markdown-code-block-container");
    if (!lineViewport) return 0;
    const paddingTop = Number.parseFloat(window.getComputedStyle(lineViewport).paddingTop) || 0;
    let top = lineViewport.clientTop + paddingTop;
    for (const flowElement of lineViewport.querySelectorAll<HTMLElement>("[aria-hidden='true'], .line[data-line]")) {
      if (flowElement === line) break;
      if (flowElement.matches(".line[data-line]")) {
        const index = getCodeSourceLineIndex(flowElement);
        if (index !== null) top += sourceLineHeights[index] ?? 20;
      } else {
        top += Number.parseFloat(flowElement.style.height ?? "0") || 0;
      }
    }
    return top - lineViewport.scrollTop;
  };
  const makePhysicalRect = (top: number, height: number): DOMRect => ({
    x: 0,
    y: top,
    width: 600,
    height,
    top,
    right: 600,
    bottom: top + height,
    left: 0,
  }) as DOMRect;
  const nativeOffsetHeight = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "offsetHeight");
  const nativeGetBoundingClientRect = window.HTMLElement.prototype.getBoundingClientRect;
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      const lineIndex = getCodeSourceLineIndex(this);
      return lineIndex === null
        ? nativeOffsetHeight?.get?.call(this) ?? 0
        : sourceLineHeights[lineIndex] ?? 20;
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value: function (this: HTMLElement): DOMRect {
      if (this.matches(".markdown-code-block-container")) {
        return makePhysicalRect(0, this.clientHeight);
      }
      const lineIndex = getCodeSourceLineIndex(this);
      if (lineIndex === null) return nativeGetBoundingClientRect.call(this);
      return makePhysicalRect(
        physicalMountedLineTop(this),
        sourceLineHeights[lineIndex] ?? 20,
      );
    },
  });

  const initialLines = Array.from({ length: 260 }, (_, index) => {
    const lineNumber = String(index).padStart(3, "0");
    return `const sourceLine${lineNumber} = "authored source ${lineNumber}";`;
  });
  const initialSource = `\`\`\`ts\n${initialLines.join("\n")}\n`;
  const anchorLine = 'const sourceLine225 = "authored source 225";';
  const firstLine = 'const sourceLine000 = "authored source 000";';
  const line200Source = 'const sourceLine200 = "authored source 200";';
  const tailLine = 'const sourceLine339 = "streamed tail 339";';
  const line310Source = 'const sourceLine310 = "streamed tail 310";';
  const tailSource = Array.from({ length: 80 }, (_, index) => {
    const lineNumber = String(index + 260).padStart(3, "0");
    return `const sourceLine${lineNumber} = "streamed tail ${lineNumber}";`;
  }).join("\n");
  let releaseTail = () => {};
  let releasePartialClose = () => {};
  let releaseClose = () => {};
  let releaseEnd = () => {};
  let signalInitialChunkConsumed = () => {};
  let signalTailChunkConsumed = () => {};
  let signalPartialCloseChunkConsumed = () => {};
  let signalCloseChunkConsumed = () => {};
  const tailGate = new Promise<void>((resolve) => { releaseTail = resolve; });
  const partialCloseGate = new Promise<void>((resolve) => { releasePartialClose = resolve; });
  const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
  const endGate = new Promise<void>((resolve) => { releaseEnd = resolve; });
  const initialChunkConsumed = new Promise<void>((resolve) => { signalInitialChunkConsumed = resolve; });
  const tailChunkConsumed = new Promise<void>((resolve) => { signalTailChunkConsumed = resolve; });
  const partialCloseChunkConsumed = new Promise<void>((resolve) => { signalPartialCloseChunkConsumed = resolve; });
  const closeChunkConsumed = new Promise<void>((resolve) => { signalCloseChunkConsumed = resolve; });
  const stream = (async function* () {
    yield initialSource;
    signalInitialChunkConsumed();
    await tailGate;
    yield `${tailSource}\n`;
    signalTailChunkConsumed();
    await partialCloseGate;
    yield "   ";
    signalPartialCloseChunkConsumed();
    await closeGate;
    yield `\`\`\`\n`;
    signalCloseChunkConsumed();
    await endGate;
  })();
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const handle = React.createRef<StreamingMarkdownHandle>();
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(React.createElement(StreamingMarkdown, {
        ref: handle,
        engine: "main",
        stream,
        features: { tables: false, html: false, mdx: false, math: false },
        caret: false,
      }));
    });
    const mountedHandle = handle.current;
    assert.ok(mountedHandle, "the public StreamingMarkdown renderer should expose its handle");
    await initialChunkConsumed;
    await act(async () => {
      await mountedHandle.waitForIdle();
    });
    await waitForMountedCodeLine(container, firstLine);

    const viewport = container.querySelector<HTMLElement>(".markdown-code-block-container");
    assert.ok(viewport, "an open code fence above the viewport threshold should use a bounded viewport before EOF");
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 10_000 });
    viewport.scrollTop = 4507;
    await act(async () => {
      viewport.dispatchEvent(new window.Event("scroll", { bubbles: true }));
    });

    await waitForMountedCodeLine(container, anchorLine);
    assert.equal(hasMountedCodeLine(container, firstLine), false, "source outside the current viewport should not be mounted");
    assert.equal(hasMountedCodeLine(container, line200Source), true, "line 200 should remain mounted in overscan above line 225");
    const line200 = Array.from(container.querySelectorAll<HTMLElement>(".line"))
      .find((line) => line.textContent === line200Source);
    const anchorBefore = Array.from(container.querySelectorAll<HTMLElement>(".line"))
      .find((line) => line.textContent === anchorLine);
    assert.ok(line200, "the overscanned line 200 should have a physical DOM target");
    assert.ok(anchorBefore, "the visible anchor should have a physical DOM target");
    const anchorOffsetBefore = anchorBefore.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    assert.equal(anchorOffsetBefore, -7, "line 225 should begin seven pixels above the viewport");

    sourceLineHeights[200] = 100;
    await act(async () => {
      ResizeObserverStub.notify(line200, sourceLineHeights[200]);
    });
    await waitForMountedCodeLine(container, anchorLine);
    const anchorAfter = Array.from(container.querySelectorAll<HTMLElement>(".line"))
      .find((line) => line.textContent === anchorLine);
    assert.ok(anchorAfter, "the literal authored line 225 should remain mounted after resizing");
    assert.equal(
      anchorAfter.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
      anchorOffsetBefore,
      "line 225 should retain its intra-line pixel offset after an earlier row grows",
    );
    assert.equal(viewport.scrollTop, 4587, "scrollTop should increase by the known 80px row-height delta");
    assert.equal(hasMountedCodeLine(container, line200Source), true, "line 200 should stay in mounted overscan");
    releaseTail();
    await tailChunkConsumed;
    await waitForCodeLineCount(container, 340);
    await waitForMountedCodeLine(container, anchorLine);
    assert.equal(hasMountedCodeLine(container, firstLine), false, "appending source should keep offscreen source unmounted");
    assert.equal(hasMountedCodeLine(container, tailLine), false, "the offscreen appended tail should not replace the anchored viewport");
    viewport.scrollTop = 339 * 20;
    await act(async () => {
      viewport.dispatchEvent(new window.Event("scroll", { bubbles: true }));
    });
    await waitForMountedCodeLine(container, tailLine);
    releasePartialClose();
    await partialCloseChunkConsumed;
    await waitForCodeLineCount(container, 341);

    viewport.scrollTop = 6287;
    await act(async () => {
      viewport.dispatchEvent(new window.Event("scroll", { bubbles: true }));
    });
    await waitForMountedCodeLine(container, line310Source);
    assert.equal(hasMountedCodeLine(container, line200Source), false, "line 200 should be unmounted above the line 310 window");
    const anchor310Before = Array.from(container.querySelectorAll<HTMLElement>(".line"))
      .find((line) => line.textContent === line310Source);
    assert.ok(anchor310Before, "the visible line 310 anchor should have a physical DOM target");
    const anchor310OffsetBefore = anchor310Before.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    assert.equal(anchor310OffsetBefore, -7, "line 310 should remain seven pixels above the viewport before closing");

    releaseClose();
    await closeChunkConsumed;
    await waitForCodeLineCount(container, 340);
    await waitForMountedCodeLine(container, line310Source);
    const anchor310After = Array.from(container.querySelectorAll<HTMLElement>(".line"))
      .find((line) => line.textContent === line310Source);
    assert.ok(anchor310After, "the same literal line 310 anchor should remain mounted after tail shrink");
    assert.equal(
      anchor310After.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
      anchor310OffsetBefore,
      "closing the fence should not move the line 310 viewport anchor",
    );
    sourceLineHeights[200] = 20;
    const growthContainer = window.document.createElement("div");
    window.document.body.append(growthContainer);
    const growthRoot = createRoot(growthContainer);
    const growthHandle = React.createRef<StreamingMarkdownHandle>();
    const growthSourceLines = Array.from({ length: 600 }, (_, index) => {
      const lineNumber = String(index).padStart(3, "0");
      return `const growthLine${lineNumber} = "growth source ${lineNumber}";`;
    });
    const growthLine000 = 'const growthLine000 = "growth source 000";';
    const growthLine599 = 'const growthLine599 = "growth source 599";';
    const growthLine200 = 'const growthLine200 = "growth source 200";';
    const growthLine201 = 'const growthLine201 = "growth source 201";';
    const growthLine225 = 'const growthLine225 = "growth source 225";';
    const growthLine570 = 'const growthLine570 = "growth source 570";';
    const growthInitialSource = `\`\`\`ts\n${growthSourceLines.slice(0, 500).join("\n")}\n`;
    const growthTailSource = `${growthSourceLines.slice(500).join("\n")}\n`;
    let releaseGrowthTail = () => {};
    let releaseGrowthEnd = () => {};
    let signalGrowthInitialChunkConsumed = () => {};
    let signalGrowthTailChunkConsumed = () => {};
    const growthTailGate = new Promise<void>((resolve) => { releaseGrowthTail = resolve; });
    const growthEndGate = new Promise<void>((resolve) => { releaseGrowthEnd = resolve; });
    const growthInitialChunkConsumed = new Promise<void>((resolve) => {
      signalGrowthInitialChunkConsumed = resolve;
    });
    const growthTailChunkConsumed = new Promise<void>((resolve) => {
      signalGrowthTailChunkConsumed = resolve;
    });
    const growthStream = (async function* () {
      yield growthInitialSource;
      signalGrowthInitialChunkConsumed();
      await growthTailGate;
      yield growthTailSource;
      signalGrowthTailChunkConsumed();
      await growthEndGate;
    })();
    try {
      await act(async () => {
        growthRoot.render(React.createElement(StreamingMarkdown, {
          ref: growthHandle,
          engine: "main",
          stream: growthStream,
          features: { tables: false, html: false, mdx: false, math: false },
          controls: { code: { copy: true } },
          caret: false,
        }));
      });
      assert.ok(growthHandle.current, "the public StreamingMarkdown renderer should expose its handle");
      await growthInitialChunkConsumed;
      await waitForCodeLineCount(growthContainer, 500);
      const growthViewport = growthContainer.querySelector<HTMLElement>(".markdown-code-block-container");
      assert.ok(growthViewport, "the streamed growth fixture should render its native code viewport");
      Object.defineProperty(growthViewport, "clientHeight", { configurable: true, value: 200 });
      {
        const getGrowthPhysicalScrollHeight = (): number => {
          const totalLines = Number(
            growthContainer
              .querySelector<HTMLElement>('[data-code-block="true"]')
              ?.getAttribute("data-code-total-lines") ?? "0",
          );
          let totalHeight = 0;
          for (let lineIndex = 0; lineIndex < totalLines; lineIndex += 1) {
            totalHeight += sourceLineHeights[lineIndex] ?? 20;
          }
          return totalHeight;
        };
        let growthScrollTop = growthViewport.scrollTop;
        Object.defineProperty(growthViewport, "scrollHeight", {
          configurable: true,
          get: getGrowthPhysicalScrollHeight,
        });
        Object.defineProperty(growthViewport, "scrollTop", {
          configurable: true,
          get: () => growthScrollTop,
          set: (nextScrollTop: number) => {
            const maxScrollTop = Math.max(
              0,
              getGrowthPhysicalScrollHeight() - growthViewport.clientHeight,
            );
            growthScrollTop = Math.min(Math.max(0, nextScrollTop), maxScrollTop);
          },
        });
      }
      growthViewport.scrollTop = 4507;
      await act(async () => {
        growthViewport.dispatchEvent(new window.Event("scroll", { bubbles: true }));
      });
      await waitForMountedCodeLine(growthContainer, growthLine200);
      const growthRow200 = Array.from(growthContainer.querySelectorAll<HTMLElement>(".line"))
        .find((line) => line.textContent === growthLine200);
      assert.ok(growthRow200, "line 200 should be a mounted public DOM measurement target");
      assert.equal(hasMountedCodeLine(growthContainer, growthLine225), true);

      sourceLineHeights[200] = 100;
      await act(async () => {
        ResizeObserverStub.notify(growthRow200, sourceLineHeights[200]);
      });
      releaseGrowthTail();
      await growthTailChunkConsumed;
      await waitForCodeLineCount(growthContainer, 600);
      assert.equal(hasMountedCodeLine(growthContainer, growthLine200), true);

      growthViewport.scrollTop = 11_480;
      await act(async () => {
        growthViewport.dispatchEvent(new window.Event("scroll", { bubbles: true }));
      });
      await waitForMountedCodeLine(growthContainer, growthLine570);
      assert.equal(hasMountedCodeLine(growthContainer, growthLine200), false);
      const anchor570 = Array.from(growthContainer.querySelectorAll<HTMLElement>(".line"))
        .find((line) => line.textContent === growthLine570);
      assert.ok(anchor570, "the literal authored line 570 should have a public DOM target");
      assert.equal(
        anchor570.getBoundingClientRect().top - growthViewport.getBoundingClientRect().top,
        0,
        "line 570 should start at the viewport top after measured geometry survives appended rows",
      );
      growthViewport.scrollTop = 4000;
      await act(async () => {
        growthViewport.dispatchEvent(new window.Event("scroll", { bubbles: true }));
      });
      await waitForMountedCodeLine(growthContainer, growthLine200);
      await waitForMountedCodeLine(growthContainer, growthLine201);
      const selectionRow200 = Array.from(growthContainer.querySelectorAll<HTMLElement>(".line"))
        .find((line) => line.textContent === growthLine200);
      const selectionRow201 = Array.from(growthContainer.querySelectorAll<HTMLElement>(".line"))
        .find((line) => line.textContent === growthLine201);
      assert.ok(selectionRow200 && selectionRow201, "lines 200 and 201 should be mounted before selecting text");
      const startWalker = window.document.createTreeWalker(selectionRow200, window.NodeFilter.SHOW_TEXT);
      const selectionStartNode = startWalker.nextNode() as Text | null;
      const endWalker = window.document.createTreeWalker(selectionRow201, window.NodeFilter.SHOW_TEXT);
      let selectionEndNode: Text | null = null;
      while (endWalker.nextNode()) selectionEndNode = endWalker.currentNode as Text;
      assert.ok(selectionStartNode && selectionEndNode, "the selected code rows should expose real text nodes");
      const selection = window.getSelection();
      assert.ok(selection, "the consumer document should expose its native Selection");
      const range = window.document.createRange();
      range.setStart(selectionStartNode, 0);
      range.setEnd(selectionEndNode, selectionEndNode.length);
      selection.removeAllRanges();
      selection.addRange(range);
      await act(async () => {
        window.document.dispatchEvent(new window.Event("selectionchange"));
      });
      const expectedAnchorNode = selection.anchorNode;
      const expectedFocusNode = selection.focusNode;
      const expectedAnchorOffset = selection.anchorOffset;
      const expectedFocusOffset = selection.focusOffset;
      assert.ok(expectedAnchorNode === selectionStartNode, "selectionchange should retain the native anchor text node");
      assert.ok(expectedFocusNode === selectionEndNode, "selectionchange should retain the native focus text node");
      assert.equal(selection.isCollapsed, false, "the native Range should select text across both code rows");

      growthViewport.scrollTop = 11_480;
      await act(async () => {
        growthViewport.dispatchEvent(new window.Event("scroll", { bubbles: true }));
      });
      await waitForMountedCodeLine(growthContainer, growthLine570);
      assert.equal(selectionStartNode.isConnected, true, "the selected line 200 text node should remain connected");
      assert.equal(selectionEndNode.isConnected, true, "the selected line 201 text node should remain connected");
      assert.ok(selection.anchorNode === expectedAnchorNode, "scrolling should retain the native anchor text node");
      assert.ok(selection.focusNode === expectedFocusNode, "scrolling should retain the native focus text node");
      assert.equal(selection.anchorOffset, expectedAnchorOffset);
      assert.equal(selection.focusOffset, expectedFocusOffset);
      const mountedGrowthLines = growthContainer.querySelectorAll<HTMLElement>(".line[data-line]").length;
      assert.ok(
        mountedGrowthLines <= 112,
        `selection should retain at most two rows beyond the 10 visible rows and 50-row overscan on each side (mounted ${mountedGrowthLines})`,
      );
      const fullContentButton = Array.from(growthContainer.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.getAttribute("aria-label")?.trim() === "Show full content" ||
          button.textContent?.trim() === "Show full content",
      );
      assert.ok(fullContentButton, "the native code block exposes an accessible full-content control");
      assert.equal(fullContentButton.type, "button");
      assert.equal(fullContentButton.getAttribute("aria-pressed"), "false");
      const controlledIds = fullContentButton.getAttribute("aria-controls");
      assert.ok(controlledIds, "the full-content control identifies its code viewport");
      assert.ok(growthViewport.id, "the native code viewport has an id for aria-controls");
      assert.ok(controlledIds.split(/\s+/).includes(growthViewport.id));
      assert.ok(window.document.getElementById(growthViewport.id) === growthViewport);

      const nativeCodeWrapper = growthContainer.querySelector<HTMLElement>('[data-code-block="true"]');
      assert.ok(nativeCodeWrapper, "the native code wrapper remains in the public DOM");
      const nativePre = nativeCodeWrapper.querySelector<HTMLElement>("pre");
      assert.ok(nativePre, "the native code wrapper contains its pre element");
      const nativeCode = nativePre.querySelector<HTMLElement>("code");
      assert.ok(nativeCode, "the native pre element contains its code element");
      assert.ok(growthViewport.contains(nativePre));
      assert.equal(nativeCodeWrapper.getAttribute("data-code-virtualized"), "true");
      assert.equal(nativeCodeWrapper.getAttribute("data-code-total-lines"), "600");

      const selectedStartRow = selectionStartNode.parentElement?.closest<HTMLElement>(".line[data-line]");
      const selectedEndRow = selectionEndNode.parentElement?.closest<HTMLElement>(".line[data-line]");
      assert.ok(selectedStartRow && selectedEndRow, "the native selection endpoints remain inside code rows");
      const nativeCodeWrapperParent = nativeCodeWrapper.parentElement;
      const nativeViewportParent = growthViewport.parentElement;
      const nativePreParent = nativePre.parentElement;
      const nativeCodeParent = nativeCode.parentElement;
      const mountedRowsBeforeFullContent = Array.from(
        growthViewport.querySelectorAll<HTMLElement>(".line[data-line]"),
      );
      const fullContentAnchor570 = Array.from(growthViewport.querySelectorAll<HTMLElement>(".line[data-line]"))
        .find((line) => line.textContent === growthLine570);
      assert.ok(fullContentAnchor570, "line 570 should be mounted again at the reader anchor before expansion");
      const fullContentAnchorOffset =
        fullContentAnchor570.getBoundingClientRect().top - growthViewport.getBoundingClientRect().top;
      assert.equal(fullContentAnchorOffset, 0, "line 570 is at the reader anchor before expansion");
      const scrollTopBeforeFullContent = growthViewport.scrollTop;

      const assertNativeCodeIdentity = (mode: string): void => {
        assert.ok(
          growthContainer.querySelector<HTMLElement>('[data-code-block="true"]') === nativeCodeWrapper,
          `${mode} keeps the native code wrapper`,
        );
        assert.ok(growthViewport.parentElement === nativeViewportParent, `${mode} does not reparent the viewport`);
        assert.ok(nativeCodeWrapper.parentElement === nativeCodeWrapperParent, `${mode} does not reparent the wrapper`);
        assert.ok(
          growthContainer.querySelector<HTMLElement>(".markdown-code-block-container") === growthViewport,
          `${mode} keeps the same native viewport`,
        );
        assert.ok(nativePre.parentElement === nativePreParent, `${mode} does not reparent the pre element`);
        assert.ok(nativeCode.parentElement === nativeCodeParent, `${mode} does not reparent the code element`);
        assert.ok(growthViewport.contains(nativePre) && nativePre.contains(nativeCode));
        assert.equal(nativeCodeWrapper.getAttribute("data-code-virtualized"), "true");
        assert.equal(nativeCodeWrapper.getAttribute("data-code-total-lines"), "600");
      };
      const assertNativeSelection = (mode: string): void => {
        assert.ok(selectionStartNode.isConnected, `${mode} keeps the selected line 200 text node connected`);
        assert.ok(selectionEndNode.isConnected, `${mode} keeps the selected line 201 text node connected`);
        assert.ok(selection.anchorNode === expectedAnchorNode, `${mode} keeps the native selection anchor`);
        assert.ok(selection.focusNode === expectedFocusNode, `${mode} keeps the native selection focus`);
        assert.equal(selection.anchorOffset, expectedAnchorOffset);
        assert.equal(selection.focusOffset, expectedFocusOffset);
        assert.equal(selection.isCollapsed, false);
        assert.ok(
          selectionStartNode.parentElement?.closest(".line[data-line]") === selectedStartRow,
          `${mode} keeps the selection anchor in the same code row`,
        );
        assert.ok(
          selectionEndNode.parentElement?.closest(".line[data-line]") === selectedEndRow,
          `${mode} keeps the selection focus in the same code row`,
        );
      };
      const assertMountedCodeRowsRetained = (mode: string): void => {
        for (const row of mountedRowsBeforeFullContent) {
          const lineNumber = row.getAttribute("data-line");
          assert.ok(
            row.isConnected &&
              growthViewport.querySelector<HTMLElement>(`.line[data-line="${lineNumber}"]`) === row,
            `${mode} keeps the existing keyed code row ${lineNumber}`,
          );
        }
      };

      await act(async () => {
        fullContentButton.click();
      });
      await waitForCodeViewportState(
        () =>
          fullContentButton.getAttribute("aria-pressed") === "true" &&
          growthViewport.querySelectorAll(".line[data-line]").length === 600,
        "explicit full-content mode mounts all 600 authored code lines",
      );
      const fullContentRows = growthViewport.querySelectorAll<HTMLElement>(".line[data-line]");
      assert.equal(fullContentRows.length, 600);
      assert.equal(fullContentButton.getAttribute("aria-pressed"), "true");
      assert.ok(hasMountedCodeLine(growthContainer, growthLine000), "full-content mode mounts authored line 0");
      assert.ok(hasMountedCodeLine(growthContainer, growthLine599), "full-content mode mounts authored line 599");
      assert.ok(fullContentButton.isConnected, "the same control remains available to restore virtualization");
      assert.equal(fullContentButton.getAttribute("aria-controls"), controlledIds);
      assert.equal(nativeCodeWrapper.getAttribute("data-code-mounted-lines"), "600");
      assertNativeCodeIdentity("full-content mode");
      assertMountedCodeRowsRetained("full-content mode");
      assert.ok(
        Array.from(fullContentRows).some((row) => row === fullContentAnchor570),
        "full-content mode keeps the same line 570 reader anchor row",
      );
      assert.equal(
        fullContentAnchor570.getBoundingClientRect().top - growthViewport.getBoundingClientRect().top,
        fullContentAnchorOffset,
      );
      assert.equal(growthViewport.scrollTop, scrollTopBeforeFullContent);
      assertNativeSelection("full-content mode");

      await act(async () => {
        fullContentButton.click();
      });
      await waitForCodeViewportState(
        () =>
          fullContentButton.getAttribute("aria-pressed") === "false" &&
          growthViewport.querySelectorAll(".line[data-line]").length <= 112 &&
          hasMountedCodeLine(growthContainer, growthLine570),
        "the same control restores a bounded viewport at the existing reader anchor",
      );
      const boundedGrowthRows = growthViewport.querySelectorAll<HTMLElement>(".line[data-line]");
      assert.ok(
        boundedGrowthRows.length <= 112,
        `returning to virtualization keeps at most 112 code rows mounted (observed ${boundedGrowthRows.length})`,
      );
      assert.equal(fullContentButton.getAttribute("aria-pressed"), "false");
      assert.ok(fullContentButton.isConnected);
      assert.equal(fullContentButton.getAttribute("aria-controls"), controlledIds);
      assert.equal(nativeCodeWrapper.getAttribute("data-code-mounted-lines"), String(boundedGrowthRows.length));
      assertNativeCodeIdentity("bounded mode");
      assertMountedCodeRowsRetained("bounded mode");
      assert.ok(
        Array.from(boundedGrowthRows).some((row) => row === fullContentAnchor570),
        "bounded mode keeps the same line 570 reader anchor row",
      );
      assert.equal(
        fullContentAnchor570.getBoundingClientRect().top - growthViewport.getBoundingClientRect().top,
        fullContentAnchorOffset,
      );
      assert.equal(growthViewport.scrollTop, scrollTopBeforeFullContent);
      assertNativeSelection("bounded mode");
      const printAnchor570 = Array.from(growthViewport.querySelectorAll<HTMLElement>(".line[data-line]"))
        .find((line) => line.textContent === growthLine570);
      assert.ok(printAnchor570, "the reader anchor is mounted before print preparation");
      const printAnchorOffset =
        printAnchor570.getBoundingClientRect().top - growthViewport.getBoundingClientRect().top;
      assert.equal(printAnchorOffset, 0, "line 570 starts at the reader anchor before print preparation");
      const scrollTopBeforePrint = growthViewport.scrollTop;
      const growthLine300 = 'const growthLine300 = "growth source 300";';
      assert.equal(
        hasMountedCodeLine(growthContainer, growthLine300),
        false,
        "line 300 is offscreen before print preparation",
      );
      const printWindow = growthViewport.ownerDocument.defaultView;
      assert.ok(printWindow, "the code viewport document exposes its print event target");

      act(() => {
        printWindow.dispatchEvent(new printWindow.Event("beforeprint"));
        const printRows = growthViewport.querySelectorAll<HTMLElement>(".line[data-line]");
        assert.equal(printRows.length, 600, "beforeprint mounts all 600 rows before its event returns");
        assert.equal(
          growthViewport.querySelector<HTMLElement>('.line[data-line="1"]')?.textContent,
          growthLine000,
          "print preparation makes literal source line 0 readable",
        );
        assert.equal(
          growthViewport.querySelector<HTMLElement>('.line[data-line="600"]')?.textContent,
          growthLine599,
          "print preparation makes literal source line 599 readable",
        );
        const printStyle = printWindow.getComputedStyle(growthViewport);
        assert.equal(printStyle.overflowX, "visible", "print preparation does not clip code horizontally");
        assert.equal(printStyle.overflowY, "visible", "print preparation does not clip code vertically");
        assert.equal(printStyle.maxHeight, "none", "print preparation removes the viewport height limit");
        assert.equal(fullContentButton.getAttribute("aria-pressed"), "false");
        assertNativeCodeIdentity("prepared print");
        assertMountedCodeRowsRetained("prepared print");
        assertNativeSelection("prepared print");

        const printOnlyRow300 = growthViewport.querySelector<HTMLElement>('.line[data-line="301"]');
        assert.ok(printOnlyRow300, "print preparation mounts offscreen source line 300");
        sourceLineHeights[300] = 100;
        ResizeObserverStub.notify(printOnlyRow300, 100);
        assert.equal(printOnlyRow300.offsetHeight, 100, "the print-only row resize reaches the DOM");
        sourceLineHeights[300] = 20;
        assert.equal(printOnlyRow300.offsetHeight, 20, "the print-only row height resets before afterprint");

        printWindow.dispatchEvent(new printWindow.Event("afterprint"));
        const afterPrintRows = growthViewport.querySelectorAll<HTMLElement>(".line[data-line]");
        assert.ok(
          afterPrintRows.length <= 112,
          `afterprint restores a bounded viewport (observed ${afterPrintRows.length} rows)`,
        );
        assert.equal(fullContentButton.getAttribute("aria-pressed"), "false");
        assert.ok(fullContentButton.isConnected, "the manual full-content control remains available after printing");
        assertNativeCodeIdentity("after print");
        assertMountedCodeRowsRetained("after print");
        assertNativeSelection("after print");
        const afterPrintAnchor570 = Array.from(afterPrintRows)
          .find((line) => line.textContent === growthLine570);
        assert.ok(
          afterPrintAnchor570 === printAnchor570,
          "afterprint restores the same fresh line 570 reader-anchor row",
        );
        assert.equal(
          printAnchor570.getBoundingClientRect().top - growthViewport.getBoundingClientRect().top,
          printAnchorOffset,
          "afterprint preserves the line 570 reader-anchor offset",
        );
        assert.equal(growthViewport.scrollTop, scrollTopBeforePrint, "afterprint preserves the reader scroll position");
      });
      await act(async () => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
      });

      {
        const appendedGrowthLine = 'const growthLine600 = "growth source 600";';
        assert.equal(
          growthViewport.scrollHeight,
          12_080,
          "the physical growth viewport height reflects all 600 public rows, including the measured 80px delta",
        );
        const bottomScrollTop = growthViewport.scrollHeight - growthViewport.clientHeight;
        growthViewport.scrollTop = bottomScrollTop;
        assert.equal(growthViewport.scrollTop, bottomScrollTop, "the browser scrollTop model clamps to physical bottom");
        await act(async () => {
          growthViewport.dispatchEvent(new window.Event("scroll", { bubbles: true }));
        });
        await waitForMountedCodeLine(growthContainer, growthLine599);
        const lastOldSourceRow = growthViewport.querySelector<HTMLElement>('.line[data-line="600"]');
        assert.ok(
          lastOldSourceRow && lastOldSourceRow.textContent === growthLine599,
          "the final authored source line is mounted at the physical bottom",
        );
        const lastOldSourceTop =
          lastOldSourceRow.getBoundingClientRect().top - growthViewport.getBoundingClientRect().top;
        assert.ok(
          lastOldSourceTop >= 0 &&
            lastOldSourceTop + lastOldSourceRow.offsetHeight <= growthViewport.clientHeight,
          "the final old source row is fully visible before appending",
        );
        const currentGrowthHandle = growthHandle.current;
        assert.ok(currentGrowthHandle, "the public StreamingMarkdown handle remains available for an open-fence append");
        currentGrowthHandle.append(`${appendedGrowthLine}\n`);
        await waitForCodeLineCount(growthContainer, 601);
        await waitForMountedCodeLine(growthContainer, appendedGrowthLine);
        await act(async () => {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        });

        const appendedGrowthRow = growthViewport.querySelector<HTMLElement>('.line[data-line="601"]');
        const lastOldSourceRowAfterAppend = growthViewport.querySelector<HTMLElement>('.line[data-line="600"]');
        assert.ok(
          appendedGrowthRow && appendedGrowthRow.textContent === appendedGrowthLine,
          "the imperative append adds a public 601st source row",
        );
        assert.equal(nativeCodeWrapper.getAttribute("data-code-total-lines"), "601");
        assert.equal(
          growthViewport.scrollHeight,
          12_100,
          "the physical scroll height grows by the appended row's measured 20px",
        );
        assert.ok(
          lastOldSourceRowAfterAppend === lastOldSourceRow,
          "the same final old source row remains mounted after append",
        );
        assert.equal(
          lastOldSourceRowAfterAppend.getBoundingClientRect().top - growthViewport.getBoundingClientRect().top,
          lastOldSourceTop,
          "appending source does not move the final old source row in the viewport",
        );
        assert.equal(
          growthViewport.scrollTop,
          bottomScrollTop,
          "the default native code view preserves the reader's scroll position instead of following the appended tail",
        );
        assertNativeSelection("append at physical bottom");
      }

      const expectedClipboardText = 'const rocket = "🚀";\r\n\r\n';
      const fencedSource = `\`\`\`ts\r\n${expectedClipboardText}\`\`\``;
      let clipboardWrite: string | null = null;
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            clipboardWrite = text;
          },
        },
      });

      await act(async () => {
        const currentGrowthHandle = growthHandle.current;
        assert.ok(currentGrowthHandle, "the public StreamingMarkdown renderer should remain mounted for the copy case");
        currentGrowthHandle.restart();
      });
      await waitForCodeViewportState(
        () =>
          growthHandle.current?.getState().workerReady === true &&
          growthHandle.current.getState().blocks.length === 0,
        "restart should provide a fresh source generation for the copy case",
      );
      await act(async () => {
        const currentGrowthHandle = growthHandle.current;
        assert.ok(currentGrowthHandle, "the public StreamingMarkdown handle should accept fresh source");
        currentGrowthHandle.append(fencedSource);
        await currentGrowthHandle.finalize();
      });
      await act(async () => {
        await growthHandle.current?.waitForIdle();
      });
      await waitForCodeViewportState(
        () => Boolean(growthContainer.querySelector('button[data-stream-mdx-action="copy"]')),
        "the native fenced TypeScript block should expose its public whole-code copy action",
      );

      const copyNativeCode = growthContainer.querySelector<HTMLElement>('[data-code-block="true"] code');
      assert.ok(copyNativeCode, "the fresh source generation should render a native code element");
      const firstCodeLine = copyNativeCode.querySelector<HTMLElement>('.line[data-line="1"]');
      assert.ok(firstCodeLine, "the native TypeScript code line should be selectable");
      const copySelection = window.getSelection();
      assert.ok(copySelection, "the consumer document should expose its native Selection");
      copySelection.removeAllRanges();
      const copyRange = window.document.createRange();
      copyRange.selectNodeContents(firstCodeLine);
      copySelection.addRange(copyRange);
      assert.equal(copySelection.isCollapsed, false, "a native code selection should exist before copying");

      const copyButton = growthContainer.querySelector<HTMLButtonElement>(
        'button[data-stream-mdx-action="copy"]',
      );
      assert.ok(copyButton, "the native whole-code copy button should be available");
      await act(async () => {
        copyButton.click();
      });
      assert.equal(
        clipboardWrite,
        expectedClipboardText,
        "whole-code copy should preserve the authored CRLFs and trailing blank line despite an active selection",
      );


      const followTailLines = Array.from({ length: 600 }, (_, index) => {
        const lineNumber = String(index + 1).padStart(3, "0");
        return `const followTailLine${lineNumber} = "follow source ${lineNumber}";`;
      });
      const followTailLastLine = followTailLines[followTailLines.length - 1];
      const appendedFollowTailLine = 'const followTailLine601 = "follow source 601";';
      const appendedWithFollowTailDisabledLine = 'const followTailLine602 = "follow source 602";';
      const followTailInitialSource = `\`\`\`ts\n${followTailLines.join("\n")}\n`;
      let releaseFollowTailStream = () => {};
      let signalFollowTailInitialChunkConsumed = () => {};
      const followTailInitialChunkConsumed = new Promise<void>((resolve) => {
        signalFollowTailInitialChunkConsumed = resolve;
      });
      const followTailStream = (async function* () {
        yield followTailInitialSource;
        signalFollowTailInitialChunkConsumed();
        await new Promise<void>((resolve) => {
          releaseFollowTailStream = resolve;
        });
      })();
      const followTailContainer = window.document.createElement("div");
      window.document.body.append(followTailContainer);
      const followTailRoot = createRoot(followTailContainer);
      const followTailHandle = React.createRef<StreamingMarkdownHandle>();
      try {
        const codeVirtualization: { followTail: boolean } = { followTail: true };
        const followTailProps = {
          ref: followTailHandle,
          engine: "main",
          stream: followTailStream,
          features: { tables: false, html: false, mdx: false, math: false },
          codeVirtualization,
          caret: false,
        } as React.ComponentProps<typeof StreamingMarkdown> & {
          codeVirtualization: typeof codeVirtualization;
        };
        await act(async () => {
          followTailRoot.render(React.createElement(StreamingMarkdown, followTailProps));
        });
        await followTailInitialChunkConsumed;
        await waitForCodeLineCount(followTailContainer, 600);
        const followTailViewport = followTailContainer.querySelector<HTMLElement>(
          ".markdown-code-block-container",
        );
        assert.ok(
          followTailViewport,
          "the public StreamingMarkdown consumer should render a native code viewport",
        );
        Object.defineProperty(followTailViewport, "clientHeight", { configurable: true, value: 200 });
        Object.defineProperty(followTailViewport, "scrollHeight", {
          configurable: true,
          get: () => {
            const codeBlock = followTailContainer.querySelector<HTMLElement>('[data-code-block="true"]');
            return Number(codeBlock?.getAttribute("data-code-total-lines") ?? "0") * 20;
          },
        });
        let followTailScrollTop = followTailViewport.scrollTop;
        Object.defineProperty(followTailViewport, "scrollTop", {
          configurable: true,
          get: () => followTailScrollTop,
          set: (nextScrollTop: number) => {
            const maxScrollTop = Math.max(
              0,
              followTailViewport.scrollHeight - followTailViewport.clientHeight,
            );
            followTailScrollTop = Math.min(Math.max(0, nextScrollTop), maxScrollTop);
          },
        });
        followTailViewport.scrollTop =
          followTailViewport.scrollHeight - followTailViewport.clientHeight;
        await act(async () => {
          followTailViewport.dispatchEvent(new window.Event("scroll", { bubbles: true }));
        });
        await waitForMountedCodeLine(followTailContainer, followTailLastLine);
        const lastOldFollowTailRow = followTailViewport.querySelector<HTMLElement>('.line[data-line="600"]');
        assert.ok(
          lastOldFollowTailRow && lastOldFollowTailRow.textContent === followTailLastLine,
          "the final old source row is mounted at the physical bottom",
        );
        const bottomBeforeAppend = followTailViewport.scrollHeight - followTailViewport.clientHeight;
        assert.equal(followTailViewport.scrollTop, bottomBeforeAppend, "the host starts at the physical bottom");

        const currentFollowTailHandle = followTailHandle.current;
        assert.ok(currentFollowTailHandle, "the public renderer handle should accept the append");
        await act(async () => {
          currentFollowTailHandle.append(`${appendedFollowTailLine}\n`);
        });
        await waitForCodeLineCount(followTailContainer, 601);
        await waitForMountedCodeLine(followTailContainer, appendedFollowTailLine);
        await act(async () => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        });
        assert.equal(
          followTailViewport.scrollHeight,
          12_020,
          "one appended row grows physical scroll height by 20px",
        );
        assert.equal(
          followTailViewport.scrollTop,
          followTailViewport.scrollHeight - followTailViewport.clientHeight,
          "codeVirtualization.followTail:true preserves at-bottom follow after one append",
        );
        const followTailCodeWrapper = followTailContainer.querySelector<HTMLElement>('[data-code-block="true"]');
        assert.ok(followTailCodeWrapper, "the native code owner remains in the public DOM");
        const firstAppendedFollowTailRow = followTailViewport.querySelector<HTMLElement>('.line[data-line="601"]');
        assert.ok(
          firstAppendedFollowTailRow && firstAppendedFollowTailRow.textContent === appendedFollowTailLine,
          "the first appended authored row is mounted at the bottom",
        );
        const followTailAnchorTop =
          firstAppendedFollowTailRow.getBoundingClientRect().top - followTailViewport.getBoundingClientRect().top;
        const scrollTopBeforeDisablingFollowTail = followTailViewport.scrollTop;
        assert.equal(
          scrollTopBeforeDisablingFollowTail,
          followTailViewport.scrollHeight - followTailViewport.clientHeight,
          "the reader is still at the first append's physical bottom before the config transition",
        );
        const followTailPropsWithFollowDisabled = {
          ...followTailProps,
          codeVirtualization: { followTail: false },
        };
        await act(async () => {
          followTailRoot.render(
            React.createElement(StreamingMarkdown, followTailPropsWithFollowDisabled),
          );
        });
        assert.equal(
          followTailContainer.querySelector(".markdown-code-block-container") === followTailViewport,
          true,
          "changing presentation config retains the same native viewport owner",
        );
        assert.equal(
          followTailContainer.querySelector('[data-code-block="true"]') === followTailCodeWrapper,
          true,
          "changing presentation config retains the same native code DOM owner",
        );
        assert.equal(
          followTailViewport.scrollTop,
          scrollTopBeforeDisablingFollowTail,
          "changing followTail presentation config does not reset the reader position",
        );
        const followTailSourceAfterConfigChange = followTailHandle.current?.getState().blocks
          .find((block) => block.type === "code")?.payload.raw;
        assert.ok(followTailSourceAfterConfigChange?.includes(followTailLastLine));
        assert.ok(followTailSourceAfterConfigChange?.includes(appendedFollowTailLine));

        const currentFollowTailHandleAfterConfigChange = followTailHandle.current;
        assert.ok(currentFollowTailHandleAfterConfigChange, "the same public renderer handle remains available");
        await act(async () => {
          currentFollowTailHandleAfterConfigChange.append(`${appendedWithFollowTailDisabledLine}\n`);
        });
        await waitForCodeLineCount(followTailContainer, 602);
        await waitForMountedCodeLine(followTailContainer, appendedWithFollowTailDisabledLine);
        await act(async () => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        });
        const oldFollowTailAnchorAfterAppend =
          followTailViewport.querySelector<HTMLElement>('.line[data-line="601"]');
        assert.ok(
          oldFollowTailAnchorAfterAppend &&
            oldFollowTailAnchorAfterAppend.textContent === appendedFollowTailLine,
          "the old visible source anchor remains the same authored row after followTail is disabled",
        );
        assert.equal(
          oldFollowTailAnchorAfterAppend.getBoundingClientRect().top - followTailViewport.getBoundingClientRect().top,
          followTailAnchorTop,
          "the old visible source anchor keeps its viewport offset after another append",
        );
        assert.equal(
          followTailViewport.scrollHeight,
          12_040,
          "the next authored row grows physical scroll height by another 20px",
        );
        assert.equal(
          followTailViewport.scrollTop,
          scrollTopBeforeDisablingFollowTail,
          "followTail:false preserves the old reader scroll position after another append",
        );
        assert.equal(
          followTailViewport.scrollTop,
          followTailViewport.scrollHeight - followTailViewport.clientHeight - 20,
          "followTail:false does not follow the newly appended physical bottom",
        );
        assert.equal(
          followTailContainer.querySelector(".markdown-code-block-container") === followTailViewport,
          true,
          "the same native viewport remains the DOM owner after the next append",
        );
        assert.equal(
          followTailContainer.querySelector('[data-code-block="true"]') === followTailCodeWrapper,
          true,
          "the same native code owner remains mounted after the next append",
        );
        assert.ok(hasMountedCodeLine(followTailContainer, followTailLastLine));
        assert.ok(hasMountedCodeLine(followTailContainer, appendedFollowTailLine));
        assert.ok(hasMountedCodeLine(followTailContainer, appendedWithFollowTailDisabledLine));
        const followTailSourceAfterAppend = followTailHandle.current?.getState().blocks
          .find((block) => block.type === "code")?.payload.raw;
        assert.ok(followTailSourceAfterAppend?.includes(followTailLastLine));
        assert.ok(followTailSourceAfterAppend?.includes(appendedFollowTailLine));
        assert.ok(followTailSourceAfterAppend?.includes(appendedWithFollowTailDisabledLine));
      } finally {
        releaseFollowTailStream();
        await act(async () => followTailRoot.unmount());
        followTailContainer.remove();
      }
      const interruptedFollowTailLines = Array.from({ length: 600 }, (_, index) => {
        const lineNumber = String(index + 1).padStart(3, "0");
        return `const interruptedLine${lineNumber} = "interrupted source ${lineNumber}";`;
      });
      const interruptedFollowTailLastLine = interruptedFollowTailLines[interruptedFollowTailLines.length - 1];
      const appendedInterruptedFollowTailLine = 'const interruptedLine601 = "interrupted source 601";';
      const interruptedFollowTailSource = `\`\`\`ts\n${interruptedFollowTailLines.join("\n")}\n`;
      let releaseInterruptedFollowTailStream = () => {};
      let signalInterruptedFollowTailChunkConsumed = () => {};
      const interruptedFollowTailChunkConsumed = new Promise<void>((resolve) => {
        signalInterruptedFollowTailChunkConsumed = resolve;
      });
      const interruptedFollowTailStream = (async function* () {
        yield interruptedFollowTailSource;
        signalInterruptedFollowTailChunkConsumed();
        await new Promise<void>((resolve) => {
          releaseInterruptedFollowTailStream = resolve;
        });
      })();
      const interruptedFollowTailContainer = window.document.createElement("div");
      window.document.body.append(interruptedFollowTailContainer);
      const interruptedFollowTailRoot = createRoot(interruptedFollowTailContainer);
      const interruptedFollowTailHandle = React.createRef<StreamingMarkdownHandle>();
      try {
        const interruptedFollowTailCodeVirtualization: { followTail: boolean } = { followTail: true };
        const interruptedFollowTailProps = {
          ref: interruptedFollowTailHandle,
          engine: "main",
          stream: interruptedFollowTailStream,
          features: { tables: false, html: false, mdx: false, math: false },
          codeVirtualization: interruptedFollowTailCodeVirtualization,
          caret: false,
        } as React.ComponentProps<typeof StreamingMarkdown> & {
          codeVirtualization: typeof interruptedFollowTailCodeVirtualization;
        };
        await act(async () => {
          interruptedFollowTailRoot.render(
            React.createElement(StreamingMarkdown, interruptedFollowTailProps),
          );
        });
        await interruptedFollowTailChunkConsumed;
        await waitForCodeLineCount(interruptedFollowTailContainer, 600);
        const interruptedFollowTailViewport = interruptedFollowTailContainer.querySelector<HTMLElement>(
          ".markdown-code-block-container",
        );
        assert.ok(
          interruptedFollowTailViewport,
          "the public StreamingMarkdown consumer should render a native code viewport for follow interruption",
        );
        Object.defineProperty(interruptedFollowTailViewport, "clientHeight", {
          configurable: true,
          value: 200,
        });
        Object.defineProperty(interruptedFollowTailViewport, "scrollHeight", {
          configurable: true,
          get: () => {
            const codeBlock = interruptedFollowTailContainer.querySelector<HTMLElement>(
              '[data-code-block="true"]',
            );
            return Number(codeBlock?.getAttribute("data-code-total-lines") ?? "0") * 20;
          },
        });
        let interruptedFollowTailScrollTop = interruptedFollowTailViewport.scrollTop;
        Object.defineProperty(interruptedFollowTailViewport, "scrollTop", {
          configurable: true,
          get: () => interruptedFollowTailScrollTop,
          set: (nextScrollTop: number) => {
            const maxScrollTop = Math.max(
              0,
              interruptedFollowTailViewport.scrollHeight - interruptedFollowTailViewport.clientHeight,
            );
            interruptedFollowTailScrollTop = Math.min(Math.max(0, nextScrollTop), maxScrollTop);
          },
        });
        interruptedFollowTailViewport.scrollTop =
          interruptedFollowTailViewport.scrollHeight - interruptedFollowTailViewport.clientHeight;
        await act(async () => {
          interruptedFollowTailViewport.dispatchEvent(new window.Event("scroll", { bubbles: true }));
        });
        await waitForMountedCodeLine(
          interruptedFollowTailContainer,
          interruptedFollowTailLastLine,
        );
        const bottomBeforeInterruption =
          interruptedFollowTailViewport.scrollHeight - interruptedFollowTailViewport.clientHeight;
        assert.equal(
          interruptedFollowTailViewport.scrollTop,
          bottomBeforeInterruption,
          "followTail:true is observably attached at the explicitly selected physical bottom",
        );
        const oldInterruptedAnchor = interruptedFollowTailViewport.querySelector<HTMLElement>(
          '.line[data-line="599"]',
        );
        assert.ok(
          oldInterruptedAnchor &&
            oldInterruptedAnchor.textContent === interruptedFollowTailLines[598],
          "the old authored source anchor is mounted before the user scroll",
        );
        const oldInterruptedAnchorTop =
          oldInterruptedAnchor.getBoundingClientRect().top -
          interruptedFollowTailViewport.getBoundingClientRect().top;

        const detachedScrollTop = bottomBeforeInterruption - 20;
        await act(async () => {
          interruptedFollowTailViewport.dispatchEvent(
            new window.WheelEvent("wheel", {
              deltaY: -20,
              bubbles: true,
              cancelable: true,
            }),
          );
          interruptedFollowTailViewport.scrollTop = detachedScrollTop;
          interruptedFollowTailViewport.dispatchEvent(new window.Event("scroll", { bubbles: true }));
        });
        assert.equal(
          interruptedFollowTailViewport.scrollTop,
          detachedScrollTop,
          "the wheel interaction moves the reader up one physical source row",
        );
        assert.equal(
          interruptedFollowTailViewport.scrollHeight -
            interruptedFollowTailViewport.clientHeight -
            interruptedFollowTailViewport.scrollTop,
          20,
          "the interrupted reader remains within one row of the physical bottom",
        );
        const interruptedAnchorTop =
          oldInterruptedAnchor.getBoundingClientRect().top -
          interruptedFollowTailViewport.getBoundingClientRect().top;
        assert.equal(
          interruptedAnchorTop,
          oldInterruptedAnchorTop + 20,
          "the old visible source anchor moves with the one-row user scroll",
        );
        const scrollTopBeforeInterruptedAppend = interruptedFollowTailViewport.scrollTop;
        const currentInterruptedFollowTailHandle = interruptedFollowTailHandle.current;
        assert.ok(currentInterruptedFollowTailHandle, "the public renderer handle should accept the append");
        await act(async () => {
          currentInterruptedFollowTailHandle.append(`${appendedInterruptedFollowTailLine}\n`);
        });
        await waitForCodeLineCount(interruptedFollowTailContainer, 601);
        await act(async () => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        });
        const oldInterruptedAnchorAfterAppend = interruptedFollowTailViewport.querySelector<HTMLElement>(
          '.line[data-line="599"]',
        );
        assert.equal(oldInterruptedAnchorAfterAppend === oldInterruptedAnchor, true);
        assert.equal(
          oldInterruptedAnchorAfterAppend?.textContent,
          interruptedFollowTailLines[598],
          "the old visible authored source anchor remains intact after the append",
        );
        assert.equal(
          oldInterruptedAnchorAfterAppend
            ? oldInterruptedAnchorAfterAppend.getBoundingClientRect().top -
                interruptedFollowTailViewport.getBoundingClientRect().top
            : null,
          interruptedAnchorTop,
          "the old visible source anchor keeps its viewport offset after the append",
        );
        assert.equal(
          interruptedFollowTailViewport.scrollTop,
          scrollTopBeforeInterruptedAppend,
          "the append preserves the reader's scroll position after the user interruption",
        );
        assert.equal(
          interruptedFollowTailViewport.scrollHeight,
          12_020,
          "one appended authored row grows the physical scroll height by 20px",
        );
        assert.equal(
          interruptedFollowTailViewport.scrollTop,
          interruptedFollowTailViewport.scrollHeight -
            interruptedFollowTailViewport.clientHeight -
            40,
          "the append does not let near-bottom tolerance override the user's interruption",
        );
        const interruptedFollowTailSourceAfterAppend = interruptedFollowTailHandle.current?.getState().blocks
          .find((block) => block.type === "code")?.payload.raw;
        assert.ok(interruptedFollowTailSourceAfterAppend?.includes(interruptedFollowTailLines[0]));
        assert.ok(interruptedFollowTailSourceAfterAppend?.includes(interruptedFollowTailLastLine));
        assert.ok(interruptedFollowTailSourceAfterAppend?.includes(appendedInterruptedFollowTailLine));
      } finally {
        releaseInterruptedFollowTailStream();
        await act(async () => interruptedFollowTailRoot.unmount());
        interruptedFollowTailContainer.remove();
      }
      sourceLineHeights.fill(20);
      const documentResetLineCount = 600;
      const documentResetFirstLine = 'const resetLine000 = "shared source start";';
      const oldDocumentResetLines = Array.from({ length: documentResetLineCount }, (_, index) =>
        index === 0
          ? documentResetFirstLine
          : `const oldResetLine${String(index).padStart(3, "0")} = "old authored source ${index}";`,
      );
      const newDocumentResetLines = Array.from({ length: documentResetLineCount }, (_, index) =>
        index === 0
          ? documentResetFirstLine
          : `const newResetLine${String(index).padStart(3, "0")} = "new authored source ${index}";`,
      );
      const documentResetSharedPrefix = `\`\`\`ts\n${documentResetFirstLine}\n`;
      const oldDocumentResetSource = `${documentResetSharedPrefix}${oldDocumentResetLines.slice(1).join("\n")}\n\`\`\`\n`;
      const newDocumentResetSource = `${documentResetSharedPrefix}${newDocumentResetLines.slice(1).join("\n")}\n\`\`\`\n`;
      const oldDocumentResetBody = oldDocumentResetLines.join("\n");
      const newDocumentResetBody = newDocumentResetLines.join("\n");

      assert.equal(oldDocumentResetLines.length, newDocumentResetLines.length);
      assert.notEqual(oldDocumentResetSource, newDocumentResetSource);
      assert.ok(oldDocumentResetSource.startsWith(documentResetSharedPrefix));
      assert.ok(newDocumentResetSource.startsWith(documentResetSharedPrefix));

      previousGlobals.set("Worker", Object.getOwnPropertyDescriptor(globalThis, "Worker"));
      Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: NodeWorker });
      const documentResetContainer = window.document.createElement("div");
      window.document.body.append(documentResetContainer);
      const documentResetRoot = createRoot(documentResetContainer);
      const documentResetHandle = React.createRef<StreamingMarkdownHandle>();
      const documentResetWorkerFactory = () => createNativeWorker();
      const documentResetProps = {
        ref: documentResetHandle,
        engine: "worker" as const,
        worker: documentResetWorkerFactory,
        contentPolicy: "markdown" as const,
        features: { tables: false, html: false, mdx: false, math: false },
        caret: false,
      };
      const renderDocumentResetSource = async (text: string): Promise<void> => {
        await act(async () => {
          documentResetRoot.render(
            React.createElement(StreamingMarkdown, { ...documentResetProps, text }),
          );
        });
      };

      try {
        await renderDocumentResetSource(oldDocumentResetSource);
        await waitForCodeLineCount(documentResetContainer, documentResetLineCount);
        const oldDocumentResetBlock = documentResetHandle.current?.getState().blocks.find(
          (block) => block.type === "code",
        );
        assert.ok(oldDocumentResetBlock, "the public reader snapshot contains the old code body");
        assert.equal(
          oldDocumentResetBlock.payload.meta?.code,
          oldDocumentResetBody,
          "the public reader snapshot preserves the exact old code body",
        );
        const oldDocumentResetViewport = documentResetContainer.querySelector<HTMLElement>(
          ".markdown-code-block-container",
        );
        assert.ok(oldDocumentResetViewport, "the closed native code document uses its bounded viewport");
        const oldDocumentResetCodeWrapper = documentResetContainer.querySelector<HTMLElement>(
          '[data-code-block="true"]',
        );
        assert.ok(oldDocumentResetCodeWrapper, "the native code wrapper remains in the public DOM");
        assert.equal(
          oldDocumentResetCodeWrapper.getAttribute("data-code-virtualized"),
          "true",
          "the large closed native code document is virtualized",
        );
        Object.defineProperty(oldDocumentResetViewport, "clientHeight", {
          configurable: true,
          value: 200,
        });
        await waitForMountedCodeLine(documentResetContainer, documentResetFirstLine);

        const oldMeasuredResetRow = Array.from(
          documentResetContainer.querySelectorAll<HTMLElement>(".line[data-line]"),
        ).find((line) => line.textContent === oldDocumentResetLines[1]);
        assert.ok(oldMeasuredResetRow, "the old document's early row has a physical DOM target");
        sourceLineHeights[1] = 100;
        await act(async () => {
          ResizeObserverStub.notify(oldMeasuredResetRow, 100);
        });
        assert.equal(oldMeasuredResetRow.offsetHeight, 100, "the old early row is measured taller than default");

        oldDocumentResetViewport.scrollTop = 6_000;
        await act(async () => {
          oldDocumentResetViewport.dispatchEvent(new window.Event("scroll", { bubbles: true }));
        });
        await waitForMountedCodeLine(documentResetContainer, oldDocumentResetLines[300]!);
        assert.equal(
          hasMountedCodeLine(documentResetContainer, documentResetFirstLine),
          false,
          "the old document is scrolled well away from its first source line",
        );

        sourceLineHeights[1] = 20;
        await renderDocumentResetSource(newDocumentResetSource);
        await waitForCodeViewportState(
          () => documentResetHandle.current?.getState().blocks.some(
            (block) =>
              block.type === "code" &&
              block.payload.meta?.code === newDocumentResetBody,
          ) === true,
          "the public snapshot publishes the exact replacement authored code body",
        );
        await waitForCodeViewportState(
          () =>
            hasMountedCodeLine(documentResetContainer, newDocumentResetLines[1]!) ||
            hasMountedCodeLine(documentResetContainer, newDocumentResetLines[300]!),
          "the replacement mounts a unique new source line at the top or retained viewport",
        );
        await waitForCodeLineCount(documentResetContainer, documentResetLineCount);
        const replacementViewportBeforeFrames = documentResetContainer.querySelector<HTMLElement>(
          ".markdown-code-block-container",
        );
        if (replacementViewportBeforeFrames) {
          Object.defineProperty(replacementViewportBeforeFrames, "clientHeight", {
            configurable: true,
            value: 200,
          });
        }
        await act(async () => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        });

        const replacementViewport = documentResetContainer.querySelector<HTMLElement>(
          ".markdown-code-block-container",
        );
        assert.ok(replacementViewport, "the replacement remains on the native code viewport");
        const replacementFirstRow = Array.from(
          documentResetContainer.querySelectorAll<HTMLElement>(".line[data-line]"),
        ).find((line) => line.textContent === documentResetFirstLine);
        const replacementMeasuredRow = Array.from(
          documentResetContainer.querySelectorAll<HTMLElement>(".line[data-line]"),
        ).find((line) => line.textContent === newDocumentResetLines[1]);
        const replacementFollowingRow = Array.from(
          documentResetContainer.querySelectorAll<HTMLElement>(".line[data-line]"),
        ).find((line) => line.textContent === newDocumentResetLines[2]);
        assert.equal(replacementViewport.scrollTop, 0, "the new document starts at scrollTop 0");
        assert.ok(replacementFirstRow, "the new document's first authored source line is rendered");
        assert.ok(replacementMeasuredRow, "the replacement's ordinary-height early row is rendered");
        assert.ok(replacementFollowingRow, "the row following the replacement's early row is rendered");
        const replacementCodeWrapper = documentResetContainer.querySelector<HTMLElement>(
          '[data-code-block="true"]',
        );
        assert.ok(replacementCodeWrapper, "the replacement remains on the native code wrapper");
        assert.equal(
          replacementCodeWrapper.getAttribute("data-code-virtualized"),
          "true",
          "the replacement remains in the same native virtualized presentation",
        );
        assert.equal(
          replacementFirstRow.getBoundingClientRect().top - replacementViewport.getBoundingClientRect().top,
          replacementViewport.clientTop +
            (Number.parseFloat(window.getComputedStyle(replacementViewport).paddingTop) || 0),
          "the new first source line has no obsolete anchor or spacer offset",
        );
        assert.equal(
          replacementFollowingRow.getBoundingClientRect().top -
            replacementMeasuredRow.getBoundingClientRect().top,
          20,
          "the row after the old measurement uses the replacement's ordinary 20px height",
        );
        assert.equal(
          hasMountedCodeLine(documentResetContainer, oldDocumentResetLines[1]!),
          false,
          "no obsolete early authored source remains rendered",
        );
      } finally {
        await act(async () => documentResetRoot.unmount());
        documentResetContainer.remove();
      }

    } finally {
      releaseGrowthTail();
      releaseGrowthEnd();
      await act(async () => growthRoot.unmount());
      growthContainer.remove();
    }
  } finally {
    releaseTail();
    releasePartialClose();
    releaseClose();
    releaseEnd();
    try {
      await act(async () => root.unmount());
    } finally {
      container.remove();
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      window.close();
    }
  }
}

runStreamingCodeViewportTest()
  .then(() => {
    console.log("streaming code viewport test passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

