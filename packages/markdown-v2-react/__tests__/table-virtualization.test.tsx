import assert from "node:assert/strict";
import { Worker as NodeWorker } from "node:worker_threads";
import type { Block, InlineNode, WorkerOut } from "@stream-mdx/core";
import { StreamingMarkdown, type StreamingMarkdownHandle, type TableElements, type TableVirtualizationOptions } from "@stream-mdx/react";
import { ComponentRegistry, MarkdownBlocksRenderer } from "@stream-mdx/react/server";
import { createInlineEngineWorker } from "@stream-mdx/worker/engine";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

const text = (value: string): InlineNode => ({ kind: "text", text: value });
const block: Block = {
  id: "consumer-table",
  type: "table",
  isFinalized: true,
  payload: {
    raw: "| ID | Description |\n| --- | --- |",
    meta: {
      header: [[text("ID")], [text("Description")]],
      rows: Array.from({ length: 120 }, (_, index) => [[text(`Row-${index}`)], [text(`Description-${index}`)]]),
    },
  },
};
const registry = new ComponentRegistry({}, {}, {}, { tableVirtualization: true });
const ssr = renderToStaticMarkup(<MarkdownBlocksRenderer blocks={[block]} componentRegistry={registry} />);
assert.equal((ssr.match(/data-row-id=/g) ?? []).length, 120, "public SSR renderer emits every body row");
assert.ok(ssr.includes("Row-119"));
assert.ok(!ssr.includes("markdown-table-spacer"));
assert.ok(!ssr.includes('data-table-virtualized="true"'));

// This implements the browser observation boundary, not a renderer collaborator.
class TestResizeObserver implements ResizeObserver {
  static instances = new Set<TestResizeObserver>();
  readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.add(this);
  }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() {
    this.targets.clear();
    TestResizeObserver.instances.delete(this);
  }
  static notify() {
    for (const observer of TestResizeObserver.instances) observer.callback([], observer);
  }
  deliverPending() { this.callback([], this); }
}

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
// Browser geometry at the public DOM boundary. Verify natural passes include all rows.
let availableWidth = 800;
let changedIdWidth: number | undefined;
let changedRowHeight = 40;
const naturalPassRowCounts: number[] = [];
const rowHeightById = new Map<string, number>();
dom.window.HTMLTableCellElement.prototype.getBoundingClientRect = function () {
  const idWidth = changedIdWidth ?? (availableWidth === 800 ? 80 : 60);
  return new dom.window.DOMRect(0, 0, this.cellIndex === 0 ? idWidth : availableWidth - idWidth, 40);
};
dom.window.HTMLTableSectionElement.prototype.getBoundingClientRect = function () {
  const height = this.tagName === "THEAD"
    ? Math.max(0, ...Array.from(
      this.querySelectorAll<HTMLTableCellElement>("tr:first-child > th, tr:first-child > td"),
      (cell) => cell.getBoundingClientRect().height,
    ))
    : Array.from(this.querySelectorAll<HTMLTableRowElement>("tr"))
      .reduce((total, row) => total + row.getBoundingClientRect().height, 0);
  return new dom.window.DOMRect(0, 0, availableWidth, height);
};
dom.window.HTMLTableRowElement.prototype.getBoundingClientRect = function () {
  const rowId = this.dataset.rowId;
  const spacerHeight = Number.parseFloat(this.style.height);
  const height = rowId ? rowHeightById.get(rowId) ?? changedRowHeight : Number.isFinite(spacerHeight) ? spacerHeight : 0;
  return new dom.window.DOMRect(0, 0, availableWidth, height);
};
dom.window.HTMLTableElement.prototype.getBoundingClientRect = function () {
  if (this.style.tableLayout !== "fixed") naturalPassRowCounts.push(this.querySelectorAll("tbody tr[data-row-id]").length);
  const headerHeight = this.querySelector("thead")?.getBoundingClientRect().height ?? 0;
  const bodyHeight = Array.from(this.querySelectorAll<HTMLTableRowElement>("tbody tr"))
    .reduce((total, row) => total + row.getBoundingClientRect().height, 0);
  return new dom.window.DOMRect(0, 0, availableWidth, headerHeight + bodyHeight);
};
Object.defineProperty(dom.window.HTMLDivElement.prototype, "clientWidth", { configurable: true, get: () => availableWidth });
const globals = {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: TestResizeObserver,
};
const previousGlobals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

/**
 * File-local deferred (Node 20 has no `Promise.withResolvers`) with the same resolve/reject
 * surface, so the stream gates and the worker dump settle exactly as before.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

const container = dom.window.document.getElementById("root");
assert.ok(container);
const root = createRoot(container);
const markdown = ["| ID | Description |", "| --- | --- |", ...Array.from({ length: 120 }, (_, index) => `| Row-${index} | Description-${index} |`)].join("\n");
const handle = React.createRef<StreamingMarkdownHandle>();
const customElements: TableElements = {
  // DOM fixture for apps/docs/components/ui/table.tsx's existing shadcn overflow-auto adapter.
  Table: (props) => <div className="relative w-full overflow-auto" style={{ overflow: "auto", overflowX: "scroll", color: "rgb(10, 20, 30)" }}
    data-custom-wrapper="true"><table {...props} data-custom="table" /></div>,
  Thead: (props) => <thead {...props} data-custom="thead" />,
  Tbody: (props) => <tbody {...props} data-custom="tbody" />,
  Tr: (props) => <tr {...props} data-custom="tr" />,
  Th: (props) => <th {...props} data-custom="th" />,
  Td: (props) => <td {...props} data-custom="td" />,
};
const replacementElements: TableElements = {
  ...customElements,
  Table: (props) => <div className="relative w-full overflow-auto" style={{ overflow: "auto" }}
    data-custom-wrapper="true" data-adapter="replacement"><table {...props} data-custom="table" /></div>,
};
const features = { tables: true };
const render = (tableVirtualization?: TableVirtualizationOptions, tableElements = customElements) => root.render(
  <StreamingMarkdown ref={handle} engine="main-thread" text={markdown} features={features} caret={false}
    tableElements={tableElements} tableVirtualization={tableVirtualization} />,
);
const rows = () => container.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row-id]");
const scrollContainer = () => container.querySelector<HTMLDivElement>('[data-table-virtualized="true"]');

try {
  render();
  await waitFor(() => rows().length === 120, "default public consumer renders all rows");
  await handle.current?.waitForIdle();
  assert.equal(scrollContainer(), null, "virtualization is opt-in");
  const firstId = rows()[0].dataset.rowId;

  render({ minRows: 40, estimatedRowHeight: 40, overscan: 2, maxHeight: 240 });
  await waitFor(() => Boolean(scrollContainer()), "config changes enable virtualization without new text");
  const viewport = scrollContainer();
  assert.ok(viewport);
  assert.equal(viewport.style.maxHeight, "240px");
  assert.ok(rows().length < 120);
  assert.equal(rows()[0].dataset.rowId, firstId, "row IDs survive full-to-windowed rendering");
  for (const tag of ["table", "thead", "tbody", "tr", "th", "td"]) {
    assert.ok(container.querySelector(`${tag}[data-custom="${tag}"]`), `custom ${tag} renders`);
  }
  assert.ok(container.querySelector('[data-custom-wrapper="true"] table'));
  assert.equal(container.querySelector("thead")?.style.position, "sticky");
  assert.equal(container.querySelector("thead")?.style.backgroundColor, "var(--stream-mdx-table-header-background, Canvas)");
  const customWrapper = container.querySelector<HTMLElement>('[data-custom-wrapper="true"]');
  assert.ok(customWrapper);
  assert.equal(customWrapper.style.getPropertyValue("overflow"), "visible");
  assert.equal(customWrapper.style.getPropertyPriority("overflow"), "important");
  assert.deepEqual(Array.from(container.querySelectorAll<HTMLTableColElement>("col"), (col) => col.style.width), ["80px", "720px"]);
  assert.ok(naturalPassRowCounts.includes(120), "columns are measured from the complete natural table");
  customWrapper.style.setProperty("color", "rgb(10, 20, 30)");
  const spacer = container.querySelector("tr.markdown-table-spacer-bottom");
  assert.equal(spacer?.getAttribute("aria-hidden"), "true");
  assert.equal(spacer?.querySelector("td")?.colSpan, 2);

  // Five 40px body rows fit below the header; measured 80px rows reduce the window.
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 240 });
  Object.defineProperty(viewport, "clientWidth", { configurable: true, get: () => availableWidth });
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    get: () => viewport.querySelector("table")?.getBoundingClientRect().height ?? 0,
  });
  let scrollTop = viewport.scrollTop;
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (requested: number) => {
      scrollTop = Math.min(Math.max(0, requested), Math.max(0, viewport.scrollHeight - viewport.clientHeight));
    },
  });
  assert.ok(viewport.scrollHeight > viewport.clientHeight, "viewport scrollHeight includes its rendered table content");
  for (const row of rows()) {
    const rowId = row.dataset.rowId;
    assert.ok(rowId);
    rowHeightById.set(rowId, 80);
    row.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 800, 80);
  }
  TestResizeObserver.notify();
  await waitFor(() => rows().length === 5, "ResizeObserver updates the window for variable row heights");
  assert.equal(rows()[0].dataset.rowId, firstId);

  availableWidth = 400;
  TestResizeObserver.notify();
  await waitFor(() => container.querySelector<HTMLTableColElement>("col")?.style.width === "60px", "viewport resize remeasures natural columns");
  assert.deepEqual(Array.from(container.querySelectorAll<HTMLTableColElement>("col"), (col) => col.style.width), ["60px", "340px"]);
  assert.equal(naturalPassRowCounts.at(-1), 120, "resize measurement uses every row, not the current window");

  viewport.scrollTop = 100000;
  assert.equal(viewport.scrollTop, viewport.scrollHeight - viewport.clientHeight,
    "the browser clamps oversized scroll offsets to the rendered content extent");
  viewport.dispatchEvent(new dom.window.Event("scroll"));
  await waitFor(() => container.textContent?.includes("Row-119") ?? false, "scroll beyond estimates still reaches the last row");
  TestResizeObserver.notify();
  await waitFor(() => container.textContent?.includes("Row-119") === true &&
    viewport.scrollTop === viewport.scrollHeight - viewport.clientHeight,
  "last row remains visible after row measurements and tail pinning settle");
  assert.ok(rows().length < 120, "the settled tail window keeps mounted data rows below the full source");
  assert.notEqual(rows()[0].dataset.rowId, firstId, "the tail window no longer includes the first source row");

  render({ enabled: true, minRows: 40, overscan: 10000, maxHeight: 320 });
  await waitFor(() => viewport.style.maxHeight === "320px", "maxHeight config updates a mounted table");
  assert.ok(rows().length <= 60, "overscan is bounded to 50 rows at the bottom");
  const pendingObservers = Array.from(TestResizeObserver.instances);
  render();
  await waitFor(() => rows().length === 120 && !scrollContainer(), "removing the config restores full rendering");
  assert.equal(customWrapper.isConnected, false, "captured wrapper is detached and tested only for cleanup");
  const liveDisabledWrapper = container.querySelector<HTMLElement>('[data-custom-wrapper="true"]');
  assert.ok(liveDisabledWrapper?.isConnected, "disabled consumer has a current connected adapter");
  assert.equal(liveDisabledWrapper.style.overflow, "auto");
  assert.equal(liveDisabledWrapper.style.overflowX, "scroll");
  assert.equal(liveDisabledWrapper.style.color, "rgb(10, 20, 30)");
  assert.equal(customWrapper.style.getPropertyValue("overflow"), "auto", "disable restores original overflow shorthand");
  assert.equal(customWrapper.style.getPropertyValue("overflow-x"), "scroll", "disable restores original longhand order");
  assert.equal(customWrapper.style.color, "rgb(10, 20, 30)", "cleanup leaves unrelated consumer inline styles intact");

  changedIdWidth = 120;
  changedRowHeight = 48;
  rowHeightById.clear();
  render({ minRows: 40, estimatedRowHeight: 40, overscan: 2, maxHeight: 240 });
  for (const observer of pendingObservers) observer.deliverPending();
  await waitFor(() => rows().length === 7 && container.querySelector<HTMLTableColElement>("col")?.style.width === "120px",
    "same-width re-enable discards old row heights and natural column widths");
  assert.equal(naturalPassRowCounts.at(-1), 120);
  const oldAdapter = container.querySelector<HTMLElement>('[data-custom-wrapper="true"]');
  assert.ok(oldAdapter?.isConnected);
  const oldNativeTable = container.querySelector("table");
  const swappedObserverCallbacks = Array.from(TestResizeObserver.instances);
  render({ minRows: 40, estimatedRowHeight: 40, overscan: 2, maxHeight: 240 }, replacementElements);
  await waitFor(() => container.querySelector<HTMLElement>('[data-adapter="replacement"]')?.style.overflow === "visible",
    "replacement overflow wrapper is normalized without disabling virtualization");
  await waitFor(() => rows().length === 7 && Array.from(TestResizeObserver.instances).every((observer) =>
    Array.from(observer.targets).every((target) => target.isConnected && container.contains(target))),
    "table/header/row observers target only current connected DOM");
  assert.notEqual(container.querySelector("table"), oldNativeTable);
  assert.equal(oldAdapter.isConnected, false);
  assert.equal(oldAdapter.style.overflow, "auto", "detached old adapter receives its original overflow");
  const liveReplacement = container.querySelector<HTMLElement>('[data-adapter="replacement"]');
  assert.ok(liveReplacement?.isConnected);
  assert.equal(liveReplacement.style.getPropertyPriority("overflow"), "important");
  for (const observer of swappedObserverCallbacks) observer.deliverPending();
  assert.equal(rows().length, 7, "queued old observer callbacks cannot change the new measurement generation");
  liveReplacement.style.setProperty("overflow", "hidden", "important");
  render(undefined, replacementElements);
  await waitFor(() => rows().length === 120 && !scrollContainer(), "replacement adapter disables normally");
  assert.equal(liveReplacement.style.overflow, "hidden", "cleanup preserves authored overflow changes");
  assert.equal(liveReplacement.style.getPropertyPriority("overflow"), "important");
  assert.ok(container.querySelector('[data-adapter="replacement"]')?.isConnected);

  root.unmount();
  const unfinishedRoot = createRoot(container);
  unfinishedRoot.render(
    <MarkdownBlocksRenderer blocks={[{ ...block, isFinalized: false }]} componentRegistry={registry} />,
  );
  await waitFor(() => rows().length === 120, "public renderer mounts every unfinished table row");
  assert.equal(scrollContainer(), null, "unfinished table snapshots do not virtualize");
  assert.equal(container.querySelector(".markdown-table-spacer"), null);
  unfinishedRoot.unmount();
  const streamingRoot = createRoot(container);
  const { promise: streamFinished, resolve: finishStream } = deferred<void>();
  const stream = (async function* () {
    yield `${markdown}\n\nStill streaming paragraph`;
    await streamFinished;
  })();
  streamingRoot.render(<StreamingMarkdown ref={handle} engine="main-thread" stream={stream} features={features} tableVirtualization={true} caret={false} />);
  await waitFor(() => rows().length === 120 && (container.textContent?.includes("Still streaming paragraph") ?? false),
    "open stream renders a completed table followed by an unfinished paragraph");
  assert.ok(handle.current?.getState().blocks.some((entry) => entry.type === "table" && entry.isFinalized),
    "the table is finalized before the surrounding stream ends");
  assert.equal(scrollContainer(), null, "a finalized table in an active session still renders every row");
  finishStream();
  await waitFor(() => Boolean(scrollContainer()), "natural iterator EOF finalizes the tail and enables table windowing");
  assert.ok(handle.current?.getState().blocks.every((entry) => entry.isFinalized));
  handle.current?.append("\n\nImperative content after EOF");
  await waitFor(() => rows().length === 120, "append after EOF reopens an imperative session despite the retained stream prop");
  handle.current?.finalize();
  await waitFor(() => Boolean(scrollContainer()), "finalize closes imperative activity after EOF");
  streamingRoot.render(<StreamingMarkdown ref={handle} engine="main-thread" className="stream-removed" features={features} tableVirtualization={true} caret={false} />);
  await waitFor(() => Boolean(container.querySelector(".stream-removed")), "stream removal commits without replacing the renderer");
  handle.current?.append("\n\nImperative content after stream removal");
  await waitFor(() => rows().length === 120, "removed stream permits imperative reuse");
  handle.current?.finalize();
  await waitFor(() => Boolean(scrollContainer()), "finalize uses current iterator ownership, not a stale stream closure");

  const { promise: oldGate, resolve: releaseOld } = deferred<void>();
  const { promise: oldFinished, resolve: markOldFinished } = deferred<void>();
  const { promise: newGate, resolve: releaseNew } = deferred<void>();
  const oldStream = (async function* () {
    try {
      yield `${markdown}\n\nOld iterator tail`;
      await oldGate;
    } finally {
      markOldFinished();
    }
  })();
  const newStream = (async function* () {
    yield `${markdown}\n\nNew iterator tail`;
    await newGate;
  })();
  streamingRoot.render(<StreamingMarkdown ref={handle} engine="main-thread" stream={oldStream} features={features} tableVirtualization={true} caret={false} />);
  await waitFor(() => rows().length === 120 && (container.textContent?.includes("Old iterator tail") ?? false), "old iterator is active");
  streamingRoot.render(<StreamingMarkdown ref={handle} engine="main-thread" stream={newStream} features={features} tableVirtualization={true} caret={false} />);
  await waitFor(() => rows().length === 120 && (container.textContent?.includes("New iterator tail") ?? false), "replacement iterator owns the session");
  releaseOld();
  await oldFinished;
  handle.current?.finalize();
  await waitFor(() => handle.current?.getState().blocks.every((entry) => entry.isFinalized) ?? false, "replacement iterator blocks finalize");
  assert.equal(scrollContainer(), null, "late cancelled iterator completion cannot clear replacement iterator ownership");
  releaseNew();
  await waitFor(() => Boolean(scrollContainer()), "replacement iterator EOF releases its own session");
  streamingRoot.unmount();
  const imperativeRoot = createRoot(container);
  imperativeRoot.render(<StreamingMarkdown ref={handle} engine="main-thread" features={features} tableVirtualization={true} caret={false} />);
  await waitFor(() => handle.current?.getState().workerReady ?? false, "imperative engine is ready");
  handle.current?.append(`${markdown}\n\n---\n\n`);
  await waitFor(() => rows().length === 120, "imperative append renders the complete table");
  assert.ok(handle.current?.getState().blocks.some((entry) => entry.type === "table" && entry.isFinalized));
  assert.equal(scrollContainer(), null, "imperative session stays active after a completed table");
  handle.current?.finalize();
  await waitFor(() => Boolean(scrollContainer()), "imperative finalize ends the session and enables windowing");
  handle.current?.append("\n\nAnother unfinished paragraph");
  await waitFor(() => rows().length === 120, "append reopens the session and restores every table row");
  assert.equal(scrollContainer(), null);
  handle.current?.restart();
  await waitFor(() => rows().length === 0, "restart clears the table and resets session activity");
  imperativeRoot.unmount();
  const externalWorker = createInlineEngineWorker();
  let externalInitializations = 0;
  externalWorker.addEventListener("message", (event: MessageEvent<WorkerOut>) => {
    if (event.data.type === "INITIALIZED") externalInitializations++;
  });
  // Use a real Worker constructor for the browser availability check and the real inline engine factory.
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: NodeWorker });
  const managedRoot = createRoot(container);
  let suppliedStreamConsumed = false;
  const unconsumedStream = (async function* () {
    suppliedStreamConsumed = true;
    yield "Content from the ignored managed iterator";
  })();
  const externalFactory = () => externalWorker;
  try {
    managedRoot.render(<StreamingMarkdown ref={handle} engine="worker" worker={externalFactory} managedWorker
      stream={unconsumedStream} features={features} tableVirtualization={true} caret={false} />);
    await waitFor(() => handle.current?.getState().workerReady ?? false, "real caller-owned worker attaches");
    externalWorker.postMessage({ type: "INIT", initialContent: `${markdown}\n\nCaller-owned tail`, docPlugins: features });
    externalWorker.postMessage({ type: "FINALIZE" });
    await waitFor(() => Boolean(scrollContainer()), "caller initialization renders the managed table");
    assert.equal(externalInitializations, 1, "attachWorker skipInit preserves caller-owned initialization");
    handle.current?.append("\n\nManaged imperative content");
    await waitFor(() => rows().length === 120, "managed imperative append opens activity");
    handle.current?.finalize();
    await waitFor(() => Boolean(scrollContainer()), "unconsumed stream prop does not prevent managed imperative finalization");
    assert.equal(externalInitializations, 1, "managed lifecycle sends no replacement initialization");
    assert.equal(suppliedStreamConsumed, false, "managed source remains caller-owned");
    handle.current?.restart();
    await waitFor(() => rows().length === 0, "managed restart clears only the renderer document");
    const dump = deferred<ReadonlyArray<Block>>();
    externalWorker.addEventListener("message", (event: MessageEvent<WorkerOut>) => {
      if (event.data.type === "DUMP_BLOCKS") dump.resolve(event.data.blocks);
    });
    externalWorker.postMessage({ type: "DUMP_BLOCKS" });
    const externalBlocks = await dump.promise;
    assert.equal(externalInitializations, 1, "skipInit restart does not reset the caller-owned engine");
    assert.ok(externalBlocks.some((block) => block.type === "table"), "caller-owned engine retains its table");
    assert.ok(externalBlocks.some((block) => block.payload.raw.includes("Managed imperative content")),
      "caller-owned engine retains imperative content after renderer restart");
  } finally {
    managedRoot.unmount();
    externalWorker.terminate();
    if (previousWorker) Object.defineProperty(globalThis, "Worker", previousWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
  assert.equal(TestResizeObserver.instances.size, 0, "unmount disconnects all table observers");
} finally {
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.window.close();
}
console.log("public table virtualization consumer tests passed");
