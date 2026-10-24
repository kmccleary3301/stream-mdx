import assert from "node:assert/strict";
import { Worker as NodeWorker } from "node:worker_threads";
import type { CodeBlockMetadata, CodeLineRange, CodeLineRecord, CodeNodeHandle } from "@stream-mdx/core";
import {
  NativeNodeView,
  StreamingMarkdown,
  useCodeBlock,
  useCodeDiff,
  useCodeLines,
  type StreamingMarkdownHandle,
} from "@stream-mdx/react";
import { createInlineEngineWorker } from "@stream-mdx/worker/engine";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type ViewId = "narrow" | "wide";
type CodeViewSnapshot = {
  readonly metadata: CodeBlockMetadata;
  readonly lines: readonly CodeLineRecord[];
};
type CapturedViews = Partial<Record<ViewId, CodeViewSnapshot>>;
type CapturedCodeHandles = Partial<Record<ViewId, CodeNodeHandle>>;
type CaptureCodeView = (id: ViewId, snapshot: CodeViewSnapshot, handle: CodeNodeHandle) => void;
type CodeSliceProps = {
  readonly id: ViewId;
  readonly handle: CodeNodeHandle;
  readonly range: CodeLineRange;
};

const NARROW_RANGE: CodeLineRange = { from: 0, to: 1 };
const NATIVE_DIFF_RANGE: CodeLineRange = { from: 1, to: 4 };
const EXPANDED_RANGE: CodeLineRange = { from: 0, to: 3 };
const CaptureCodeViewContext = React.createContext<CaptureCodeView>(() => {});

function CodeSlice({ id, handle, range }: CodeSliceProps): React.ReactElement {
  const metadata = useCodeBlock(handle);
  const lines = useCodeLines(handle, range);
  const capture = React.useContext(CaptureCodeViewContext);
  capture(id, { metadata, lines }, handle);

  return (
    <section
      data-native-code-view={id}
      data-native-code-presentation="headless"
      data-owner-id={metadata.codeOwnerId}
      data-generation={metadata.generation}
      data-revision={metadata.revision}
      data-state={metadata.state}
      data-line-count={metadata.lineCount}
      data-complete-line-count={metadata.completeLineCount}
      data-source-from={metadata.sourceRange.from}
      data-source-to={metadata.sourceRange.to}
      data-info={metadata.info}
      data-language={metadata.language}
      data-configuration-revision={metadata.configurationRevision}
    >
      {lines.map((line) => {
        const tokens = line.decoration && line.decoration.exactness !== "unavailable"
          ? line.decoration.tokens.spans
          : undefined;
        return (
          <div
            key={line.id}
            data-code-line={line.index}
            data-code-line-text={line.text}
            data-exactness={line.decoration?.exactness ?? "none"}
          >
            {tokens
              ? tokens.map((token, tokenIndex) => <span data-token key={`${line.id}:${tokenIndex}`}>{token.t}</span>)
              : line.text}
          </div>
        );
      })}
    </section>
  );
}

type HeadlessCodeProps = { readonly handle: CodeNodeHandle };

function HeadlessCode({ handle }: HeadlessCodeProps): React.ReactElement {
  const [wideExpanded, setWideExpanded] = React.useState(false);
  const [narrowMounted, setNarrowMounted] = React.useState(true);

  return (
    <>
      <button type="button" data-expand-code-range onClick={() => setWideExpanded(true)}>
        Expand code range
      </button>
      <button type="button" data-unmount-narrow-view onClick={() => setNarrowMounted(false)}>
        Close narrow code view
      </button>
      {narrowMounted ? <CodeSlice id="narrow" handle={handle} range={NARROW_RANGE} /> : null}
      <CodeSlice id="wide" handle={handle} range={wideExpanded ? EXPANDED_RANGE : NARROW_RANGE} />
    </>
  );
}

function readView(container: HTMLElement, id: ViewId): HTMLElement {
  const view = container.querySelector<HTMLElement>(`[data-native-code-view="${id}"]`);
  assert.ok(view, `missing ${id} headless native code view`);
  return view;
}

function readLine(view: HTMLElement, index: number): HTMLElement {
  const line = view.querySelector<HTMLElement>(`[data-code-line="${index}"]`);
  assert.ok(line, `missing native code line ${index}`);
  return line;
}

function readSnapshot(captured: CapturedViews, id: ViewId): CodeViewSnapshot {
  const snapshot = captured[id];
  assert.ok(snapshot, `missing captured ${id} hook snapshot`);
  return snapshot;
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

type NativeCodeStatusCapture = {
  readonly metadata: CodeBlockMetadata;
  readonly handle: CodeNodeHandle;
  readonly diff: {
    readonly diffStatus: CodeBlockMetadata["diffStatus"];
    readonly lines: readonly CodeLineRecord[];
  };
  readonly renderCount: number;
};
type CaptureNativeCodeStatus = (entry: NativeCodeStatusCapture) => void;
type NativeCodeStatusProps = { readonly handle: CodeNodeHandle };

const NativeCodeStatusContext = React.createContext<CaptureNativeCodeStatus>(() => {});

function NativeCodeStatusView({ handle }: NativeCodeStatusProps): React.ReactElement {
  const diff = useCodeDiff(handle, NATIVE_DIFF_RANGE);
  const renderCount = React.useRef(0);
  renderCount.current += 1;
  const capture = React.useContext(NativeCodeStatusContext);
  capture({ metadata: handle.readMetadata(), handle, diff, renderCount: renderCount.current });
  return (
    <div data-native-code-owner={handle.readMetadata().codeOwnerId} data-diff-status={diff.diffStatus}>
      <NativeNodeView handle={handle} />
    </div>
  );
}

async function runNativeCodeHandlePresentationTest(): Promise<void> {
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
  const captured: CapturedViews = {};
  const capturedCodeHandles: CapturedCodeHandles = {};
  const capture: CaptureCodeView = (id, snapshot, codeHandle) => {
    captured[id] = snapshot;
    capturedCodeHandles[id] = codeHandle;
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
        <CaptureCodeViewContext.Provider value={capture}>
          <StreamingMarkdown
            ref={handle}
            engine="worker"
            worker={() => worker!}
            components={{ code: { view: HeadlessCode } }}
            features={{ html: false, mdx: false, tables: false, math: false }}
            caret={false}
            onError={(error) => workerErrors.push(error)}
          />
        </CaptureCodeViewContext.Provider>,
      );
    });
    await waitFor(() => handle.current?.getState().workerReady === true, "the actual inline worker to become ready");
    assert.equal(workerErrors.length, 0, "the native worker initializes without errors");
    const streamHandle = handle.current;
    assert.ok(streamHandle, "the public streaming handle is available");

    await act(async () => {
      streamHandle.append("```typescript\nconst first = 1;\n");
    });
    await waitFor(() => {
      const narrow = container.querySelector<HTMLElement>('[data-native-code-view="narrow"]');
      const wide = container.querySelector<HTMLElement>('[data-native-code-view="wide"]');
      return narrow?.querySelector('[data-code-line="0"]')?.textContent === "const first = 1;"
        && wide?.querySelector('[data-code-line="0"]')?.textContent === "const first = 1;";
    }, "both registered headless subviews to render the first real native code line");

    const narrowInitialView = readView(container, "narrow");
    const wideInitialView = readView(container, "wide");
    assert.equal(container.querySelectorAll("[data-native-code-presentation=\"headless\"]").length, 2);
    assert.equal(narrowInitialView.dataset.state, "open");
    assert.equal(narrowInitialView.dataset.info, "typescript");
    assert.equal(narrowInitialView.dataset.language, "typescript");
    assert.equal(Number(narrowInitialView.dataset.completeLineCount), 1, "native metadata reports the authored complete first line");
    assert.ok(narrowInitialView.dataset.ownerId);
    assert.equal(narrowInitialView.dataset.ownerId, wideInitialView.dataset.ownerId, "both subviews observe one native code owner");
    assert.equal(narrowInitialView.dataset.generation, wideInitialView.dataset.generation);
    assert.equal(readLine(narrowInitialView, 0).dataset.codeLineText, "const first = 1;");
    assert.equal(readLine(wideInitialView, 0).textContent, "const first = 1;");

    await waitFor(
      () =>
        readSnapshot(captured, "narrow").lines[0]?.decoration?.exactness === "exact" &&
        readSnapshot(captured, "wide").lines[0]?.decoration?.exactness === "exact",
      "the first demanded native line to finish exact grammar preparation before pinning its snapshot",
    );

    const narrowBeforeAppend = readSnapshot(captured, "narrow");
    const wideBeforeAppend = readSnapshot(captured, "wide");
    const retainedCodeHandle = capturedCodeHandles.narrow;
    assert.ok(retainedCodeHandle, "the first native view retains its actual code-node handle");
    const retainedMetadataBeforeAppend = retainedCodeHandle.readMetadata();
    assert.equal(retainedMetadataBeforeAppend.codeOwnerId, narrowBeforeAppend.metadata.codeOwnerId);
    assert.equal(retainedMetadataBeforeAppend.generation, narrowBeforeAppend.metadata.generation);
    const narrowRangeBeforeAppend = narrowBeforeAppend.lines;
    const wideRangeBeforeAppend = wideBeforeAppend.lines;
    const narrowFirstRecordBeforeAppend = narrowBeforeAppend.lines[0];
    const wideFirstRecordBeforeAppend = wideBeforeAppend.lines[0];
    const initialRevision = Number(narrowBeforeAppend.metadata.revision);

    await act(async () => {
      streamHandle.append("const second = 2;\n");
    });
    await waitFor(() => {
      const narrow = container.querySelector<HTMLElement>('[data-native-code-view="narrow"]');
      return Number(narrow?.dataset.completeLineCount) === 2;
    }, "native source metadata to commit the second authored line");
    assert.equal(workerErrors.length, 0, "the worker commits the appended code without errors");
    assert.equal(readLine(readView(container, "narrow"), 0).textContent, "const first = 1;");
    assert.strictEqual(readSnapshot(captured, "narrow").lines, narrowRangeBeforeAppend, "the unchanged narrow range keeps its snapshot identity");
    assert.strictEqual(readSnapshot(captured, "narrow").lines[0], narrowFirstRecordBeforeAppend, "the unchanged narrow record keeps its identity");
    assert.strictEqual(readSnapshot(captured, "wide").lines, wideRangeBeforeAppend, "the second consumer keeps its unchanged range identity");
    assert.strictEqual(readSnapshot(captured, "wide").lines[0], wideFirstRecordBeforeAppend, "the second consumer keeps its unchanged record identity");
    assert.ok(Number(readView(container, "wide").dataset.revision) > initialRevision);

    await act(async () => {
      const expandButton = container.querySelector<HTMLButtonElement>("[data-expand-code-range]");
      assert.ok(expandButton, "the headless view exposes its range expansion control");
      expandButton.click();
    });
    await waitFor(() => {
      const wide = container.querySelector<HTMLElement>('[data-native-code-view="wide"]');
      return wide?.querySelector('[data-code-line="1"]')?.textContent === "const second = 2;";
    }, "the expanded wide range to render the second committed line");
    assert.equal(readLine(readView(container, "wide"), 1).dataset.codeLineText, "const second = 2;");
    assert.strictEqual(readSnapshot(captured, "wide").lines[0], wideFirstRecordBeforeAppend, "range expansion retains the first prepared record");

    await act(async () => {
      const closeButton = container.querySelector<HTMLButtonElement>("[data-unmount-narrow-view]");
      assert.ok(closeButton, "the headless view exposes its narrow-consumer unmount control");
      closeButton.click();
    });
    await waitFor(
      () => container.querySelector('[data-native-code-view="narrow"]') === null,
      "the narrow hook consumer to unmount independently",
    );

    const beforeThirdAppend = readSnapshot(captured, "wide");
    const secondRevision = Number(beforeThirdAppend.metadata.revision);
    await act(async () => {
      streamHandle.append("const third = 3;\n");
    });
    await waitFor(() => {
      const wide = container.querySelector<HTMLElement>('[data-native-code-view="wide"]');
      return wide?.querySelector('[data-code-line="2"]')?.textContent === "const third = 3;";
    }, "the remaining wide consumer to receive the real third-line append");
    assert.equal(container.querySelector('[data-native-code-view="narrow"]'), null);
    assert.equal(readLine(readView(container, "wide"), 2).dataset.codeLineText, "const third = 3;");
    assert.ok(Number(readView(container, "wide").dataset.revision) > secondRevision);
    assert.strictEqual(readSnapshot(captured, "wide").lines[0], wideFirstRecordBeforeAppend, "later appends retain the unchanged first record");

    await act(async () => {
      await streamHandle.finalize();
    });
    await waitFor(
      () => container.querySelector<HTMLElement>('[data-native-code-view="wide"]')?.dataset.state === "finalized",
      "the headless metadata to observe native code finalization",
    );
    assert.equal(readView(container, "wide").dataset.state, "finalized");
    assert.equal(Number(readView(container, "wide").dataset.completeLineCount), 3);
    await waitFor(() => {
      const thirdLine = container.querySelector<HTMLElement>('[data-native-code-view="wide"] [data-code-line="2"]');
      return thirdLine?.dataset.exactness === "exact";
    }, "the actual worker-prepared decoration to reach the subscribed native line range");
    const decoratedThirdLine = readLine(readView(container, "wide"), 2);
    assert.equal(decoratedThirdLine.textContent, "const third = 3;");
    assert.ok(decoratedThirdLine.querySelector("[data-token]"), "the headless view renders the native worker's prepared token spans");
    const retainedFinalMetadata = retainedCodeHandle.readMetadata();
    assert.equal(retainedFinalMetadata.codeOwnerId, retainedMetadataBeforeAppend.codeOwnerId);
    assert.equal(retainedFinalMetadata.generation, retainedMetadataBeforeAppend.generation);
    assert.equal(retainedFinalMetadata.codeOwnerId, readView(container, "wide").dataset.ownerId);
    assert.equal(retainedFinalMetadata.generation, Number(readView(container, "wide").dataset.generation));
    assert.equal(retainedFinalMetadata.completeLineCount, 3, "the retained handle reports all authored complete lines");
    assert.equal(retainedFinalMetadata.lineCount, 3);
    assert.equal(retainedFinalMetadata.info, "typescript");
    assert.equal(retainedFinalMetadata.language, "typescript");
    assert.deepEqual(
      retainedCodeHandle.readLines({ from: 0, to: 3 }).map(({ index, text }) => [index, text]),
      [
        [0, "const first = 1;"],
        [1, "const second = 2;"],
        [2, "const third = 3;"],
      ],
      "the retained handle reads the final native line records",
    );
    assert.equal(workerErrors.length, 0, "the worker completes the stream and code decoration without errors");
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

async function runNativeCodeDiffStatusTest(): Promise<void> {
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
  const entries = new Map<string, NativeCodeStatusCapture>();
  const capture: CaptureNativeCodeStatus = (entry) => {
    entries.set(entry.metadata.codeOwnerId, entry);
  };
  const handle = React.createRef<StreamingMarkdownHandle>();
  const workerErrors: Error[] = [];
  let root: Root | undefined;
  let worker: Worker | undefined;
  const latestEntry = (): NativeCodeStatusCapture | undefined => {
    let latest: NativeCodeStatusCapture | undefined;
    for (const entry of entries.values()) latest = entry;
    return latest;
  };

  try {
    worker = createInlineEngineWorker() as unknown as Worker;
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <NativeCodeStatusContext.Provider value={capture}>
          <StreamingMarkdown
            ref={handle}
            engine="worker"
            worker={() => worker!}
            components={{ code: { view: NativeCodeStatusView } }}
            features={{ html: false, mdx: false, tables: false, math: false }}
            caret={false}
            onError={(error) => workerErrors.push(error)}
          />
        </NativeCodeStatusContext.Provider>,
      );
    });
    await waitFor(() => handle.current?.getState().workerReady === true, "the real inline worker to become ready for diff status");
    assert.equal(workerErrors.length, 0, "the native worker initializes without errors");
    const streamHandle = handle.current;
    assert.ok(streamHandle, "the public streaming handle is available for native diff status");

    await act(async () => {
      streamHandle.append("```diff ts\n@@ -10,4 +20,4 @@\n context\n-old\n+new\n");
    });
    await waitFor(() => entries.size >= 1 && latestEntry()?.diff.lines.length === 3, "the first native diff code handle rows");
    await waitFor(
      () => container.querySelector("[data-native-code-owner] pre code")?.textContent?.includes("context") === true,
      "the specialized code handle selects the native code fallback without presentation recursion",
    );
    let entry = latestEntry();
    assert.ok(entry);
    assert.equal(entry.metadata.diffStatus, "incomplete", "the React code metadata reports rows still owed");
    assert.equal(entry.handle.readMetadata().diffStatus, "incomplete", "the retained native handle reports rows still owed");
    assert.deepEqual(
      entry.diff.lines.map(({ text, diffKind, oldNo, newNo }) => [text, diffKind, oldNo ?? null, newNo ?? null]),
      [
        [" context", "context", 10, 20],
        ["-old", "del", 11, null],
        ["+new", "add", null, 21],
      ],
      "the ranged diff hook exposes source rows with their kinds and one-based side numbers",
    );
    await waitFor(
      () => latestEntry()?.diff.lines.every((line) => line.decoration?.exactness !== undefined) === true,
      "the ranged diff hook to expose token exactness",
    );
    entry = latestEntry();
    assert.ok(entry);
    const initialDiffLines = entry.diff.lines;
    const renderCountBeforeOutsideAppend = entry.renderCount;

    await act(async () => {
      streamHandle.append(" tail one\n");
    });
    await waitFor(
      () => entry.handle.readMetadata().completeLineCount === 5,
      "an out-of-range diff row to commit",
    );
    assert.equal(entry.handle.readMetadata().diffStatus, "incomplete");
    assert.strictEqual(latestEntry()?.renderCount, renderCountBeforeOutsideAppend, "the bounded diff view does not rerender for an out-of-range append");
    assert.strictEqual(latestEntry()?.diff.lines, initialDiffLines, "the unchanged diff range retains its record collection");

    await act(async () => {
      streamHandle.append(" tail two\n");
    });
    await waitFor(
      () => latestEntry()?.metadata.diffStatus === "complete",
      "the final declared diff row to complete the hunk",
    );
    entry = latestEntry();
    assert.ok(entry);
    assert.equal(entry.metadata.diffStatus, "complete", "the hook status follows hunk completion");
    assert.equal(entry.handle.readMetadata().diffStatus, "complete", "the retained native handle reports satisfied row counts");
    assert.deepEqual(entry.diff.lines.map(({ id }) => id), initialDiffLines.map(({ id }) => id), "status changes retain the selected diff rows");

    await act(async () => {
      streamHandle.append("```\n```diff\n@@ -1,3 +1,3 @@\n a\n@@ -10,1 +10,1 @@\n");
    });
    await waitFor(() => entries.size >= 2, "the second native diff code handle");
    entry = latestEntry();
    assert.ok(entry);
    assert.equal(entry.metadata.diffStatus, "malformed", "a later hunk header abandons owed rows");
    assert.equal(entry.handle.readMetadata().diffStatus, "malformed", "the retained handle preserves abandoned-row status");

    await act(async () => {
      streamHandle.append("```\n```typescript\nconst plain = true;\n```\n");
    });
    await waitFor(() => entries.size >= 3, "the native ordinary code handle");
    entry = latestEntry();
    assert.ok(entry);
    assert.equal(Object.hasOwn(entry.metadata, "diffStatus"), false, "ordinary React code metadata omits diff status");
    assert.equal(Object.hasOwn(entry.handle.readMetadata(), "diffStatus"), false, "ordinary native code metadata omits diff status");

    await act(async () => {
      streamHandle.append("```diff\n@@ -1,3 +1,3 @@\n a\n");
    });
    await waitFor(() => entries.size >= 4, "the short native diff code handle");
    await act(async () => {
      await streamHandle.finalize();
    });
    await waitFor(
      () => latestEntry()?.metadata.state === "finalized",
      "the short diff document to finalize",
    );
    entry = latestEntry();
    assert.ok(entry);
    assert.equal(entry.metadata.diffStatus, "malformed", "finalizing with owed rows marks the diff malformed");
    assert.equal(entry.handle.readMetadata().diffStatus, "malformed", "the retained handle reports finalized malformation");
    assert.equal(workerErrors.length, 0, "the worker completes the native diff status stream without errors");
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

await runNativeCodeHandlePresentationTest();
await runNativeCodeDiffStatusTest();

console.log("native-code-handle-presentation test passed");
