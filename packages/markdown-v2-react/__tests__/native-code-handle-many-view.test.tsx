import assert from "node:assert/strict";
import { Worker as NodeWorker } from "node:worker_threads";
import type { CodeLineRecord, CodeNodeHandle } from "@stream-mdx/core";
import { StreamingMarkdown, useCodeBlock, useCodeLines, type StreamingMarkdownHandle } from "@stream-mdx/react";
import { createInlineEngineWorker } from "@stream-mdx/worker/engine";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const INITIAL_ROW_COUNT = 500;
const FIRST_ROW = 'const authoredRow000 = "value-000";';
const MIDDLE_ROW = 'const authoredRow249 = "value-249";';
const LAST_ROW = 'const authoredRow499 = "value-499";';
const TAIL_ROW = 'const appendedTail = "tail-500";';

type CaptureCodeLines = (index: number, lines: readonly CodeLineRecord[]) => void;
const CaptureCodeLinesContext = React.createContext<CaptureCodeLines>(() => {});

type CodeRangeRowProps = { readonly handle: CodeNodeHandle; readonly index: number };

function CodeRangeRow({ handle, index }: CodeRangeRowProps): React.ReactElement {
  const lines = useCodeLines(handle, { from: index, to: index + 1 });
  React.useContext(CaptureCodeLinesContext)(index, lines);
  return <div data-code-row={index}>{lines[0]?.text}</div>;
}

type ManyCodeViewsProps = { readonly handle: CodeNodeHandle };

function ManyCodeViews({ handle }: ManyCodeViewsProps): React.ReactElement {
  const metadata = useCodeBlock(handle);
  return (
    <section
      data-code-owner-id={metadata.codeOwnerId}
      data-complete-line-count={metadata.completeLineCount}
      data-info={metadata.info}
      data-state={metadata.state}
    >
      {Array.from({ length: INITIAL_ROW_COUNT }, (_, index) => (
        <CodeRangeRow key={index} handle={handle} index={index} />
      ))}
      {metadata.completeLineCount > INITIAL_ROW_COUNT
        ? <CodeRangeRow key="tail" handle={handle} index={INITIAL_ROW_COUNT} />
        : null}
    </section>
  );
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${message}`);
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function runNativeCodeHandleManyViewTest(): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Worker: NodeWorker,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const globalKeys = Object.keys(globals) as Array<keyof typeof globals>;
  const previousGlobals = Object.fromEntries(
    globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as Record<keyof typeof globals, PropertyDescriptor | undefined>;
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  let latestFirstSnapshot: readonly CodeLineRecord[] | undefined;
  const capture: CaptureCodeLines = (index, lines) => {
    if (index === 0) latestFirstSnapshot = lines;
  };
  const handle = React.createRef<StreamingMarkdownHandle>();
  const workerErrors: Error[] = [];
  let root: Root | undefined;
  let worker: Worker | undefined;

  try {
    worker = createInlineEngineWorker() as unknown as Worker;
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <CaptureCodeLinesContext.Provider value={capture}>
          <StreamingMarkdown
            ref={handle}
            engine="worker"
            worker={() => worker!}
            components={{ code: { view: ManyCodeViews } }}
            features={{ html: false, mdx: false, tables: false, math: false, codeHighlighting: "incremental" }}
            caret={false}
            onError={(error) => workerErrors.push(error)}
          />
        </CaptureCodeLinesContext.Provider>,
      );
    });
    await waitFor(() => handle.current?.getState().workerReady === true, "the actual inline worker to become ready");
    assert.equal(workerErrors.length, 0, "the native worker initializes without errors");
    const streamHandle = handle.current;
    assert.ok(streamHandle, "the public streaming handle is available");

    const initialRows = Array.from(
      { length: INITIAL_ROW_COUNT },
      (_, index) => `const authoredRow${String(index).padStart(3, "0")} = "value-${String(index).padStart(3, "0")}";`,
    );
    await act(async () => {
      streamHandle.append(`\`\`\`text\n${initialRows.join("\n")}\n`);
    });
    await waitFor(() => {
      const owner = container.querySelector<HTMLElement>("[data-code-owner-id]");
      return owner?.dataset.completeLineCount === "500"
        && container.querySelector('[data-code-row="0"]')?.textContent === FIRST_ROW
        && container.querySelector('[data-code-row="249"]')?.textContent === MIDDLE_ROW
        && container.querySelector('[data-code-row="499"]')?.textContent === LAST_ROW;
    }, "500 authored native code rows to publish through the actual worker");

    const ownerBeforeAppend = container.querySelector<HTMLElement>("[data-code-owner-id]");
    assert.ok(ownerBeforeAppend, "the canonical code view receives published native owner metadata");
    const ownerIdBeforeAppend = ownerBeforeAppend.dataset.codeOwnerId;
    assert.ok(ownerIdBeforeAppend, "the native code owner has a public owner ID");
    assert.equal(ownerBeforeAppend.dataset.info, "text");
    assert.equal(ownerBeforeAppend.dataset.state, "open");
    assert.equal(ownerBeforeAppend.dataset.completeLineCount, "500");
    assert.equal(container.querySelectorAll("[data-code-row]").length, 500, "500 sibling range consumers are mounted");

    const firstSnapshotBeforeAppend = latestFirstSnapshot;
    assert.ok(firstSnapshotBeforeAppend?.[0], "the first row consumer received a public line snapshot");
    assert.equal(firstSnapshotBeforeAppend[0].text, FIRST_ROW);

    await act(async () => {
      streamHandle.append(`${TAIL_ROW}\n`);
    });
    await waitFor(() => {
      const owner = container.querySelector<HTMLElement>("[data-code-owner-id]");
      return owner?.dataset.completeLineCount === "501"
        && container.querySelector('[data-code-row="500"]')?.textContent === TAIL_ROW;
    }, "the appended native tail row to publish to a range consumer");

    const ownerAfterAppend = container.querySelector<HTMLElement>("[data-code-owner-id]");
    assert.ok(ownerAfterAppend);
    assert.equal(ownerAfterAppend.dataset.codeOwnerId, ownerIdBeforeAppend, "appending retains the native code owner");
    assert.equal(ownerAfterAppend.dataset.completeLineCount, "501");
    assert.equal(container.querySelector('[data-code-row="0"]')?.textContent, FIRST_ROW);
    assert.equal(container.querySelector('[data-code-row="249"]')?.textContent, MIDDLE_ROW);
    assert.equal(container.querySelector('[data-code-row="499"]')?.textContent, LAST_ROW);
    assert.equal(firstSnapshotBeforeAppend[0].text, FIRST_ROW, "the retained first-row snapshot remains unchanged after appending");
    assert.equal(workerErrors.length, 0, "the worker publishes all authored rows without errors");
  } finally {
    try {
      if (root) await act(async () => root!.unmount());
    } finally {
      try {
        await worker?.terminate();
      } finally {
        container.remove();
        for (const key of globalKeys) {
          const descriptor = previousGlobals[key];
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
        dom.window.close();
      }
    }
  }
}

await runNativeCodeHandleManyViewTest();
console.log("native code handle many-view test passed");
