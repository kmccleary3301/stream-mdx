import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert/strict";
import { Worker as NodeWorker } from "node:worker_threads";
import type { Block, InlineNode, WorkerOut } from "@stream-mdx/core";
import { StreamingMarkdown, type StreamingMarkdownHandle, type TableVirtualizationOptions } from "@stream-mdx/react";
import { ComponentRegistry, MarkdownBlocksRenderer, createRendererStore } from "@stream-mdx/react/server";
import { compileMarkdownSnapshotDirect } from "@stream-mdx/worker/direct";
import { createInlineEngineWorker } from "@stream-mdx/worker/engine";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MarkdownBlocksRenderer as SourceMarkdownBlocksRenderer } from "../src/renderer/blocks-renderer";
import { StreamingActivityContext } from "../src/renderer/streaming-activity-context";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_TABLE_VIRTUALIZATION_CONFIG, resolveTableVirtualizationConfig } from "../src/renderer/virtualized-table";

function testTableVirtualizationConfig(): void {
  const defaults = {
    enabled: true,
    minRows: 40,
    virtualizeThreshold: 40,
    estimatedRowHeight: 40,
    overscan: 8,
    maxHeight: "600px",
  };
  assert.equal(resolveTableVirtualizationConfig(), DEFAULT_TABLE_VIRTUALIZATION_CONFIG);
  assert.equal(resolveTableVirtualizationConfig(false), DEFAULT_TABLE_VIRTUALIZATION_CONFIG);
  assert.deepEqual(resolveTableVirtualizationConfig(true), { ...defaults });
  assert.deepEqual(resolveTableVirtualizationConfig({}), { ...defaults });
  assert.deepEqual(
    resolveTableVirtualizationConfig({
      enabled: false,
      minRows: 3.9,
      virtualizeThreshold: 9,
      overscan: 2.9,
      estimatedRowHeight: 24,
      maxHeight: 320,
    }),
    {
      enabled: false,
      minRows: 3,
      virtualizeThreshold: 3,
      overscan: 2,
      estimatedRowHeight: 24,
      maxHeight: 320,
    },
  );
  assert.deepEqual(
    resolveTableVirtualizationConfig({
      virtualizeThreshold: 5.7,
      overscan: 100,
      estimatedRowHeight: 0,
      maxHeight: undefined,
    }),
    {
      enabled: true,
      minRows: 5,
      virtualizeThreshold: 5,
      estimatedRowHeight: 40,
      overscan: 50,
      maxHeight: "600px",
    },
  );
  assert.deepEqual(
    resolveTableVirtualizationConfig({
      minRows: Number.NaN,
      virtualizeThreshold: Number.POSITIVE_INFINITY,
      overscan: Number.NaN,
      estimatedRowHeight: Number.POSITIVE_INFINITY,
    }),
    { ...defaults },
  );
  assert.deepEqual(
    resolveTableVirtualizationConfig({
      minRows: 0,
      overscan: -1,
      estimatedRowHeight: -1,
    }),
    { ...defaults, minRows: 1, virtualizeThreshold: 1, overscan: 1 },
  );
}

testTableVirtualizationConfig();
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
const registry = new ComponentRegistry({
  tableVirtualization: true,
  components: {
    "table-row": { props: { "data-static-row-presentation": "true" } },
    "table-cell": { props: { "data-static-cell-presentation": "true" } },
  },
});
const ssr = renderToStaticMarkup(<MarkdownBlocksRenderer blocks={[block]} componentRegistry={registry} />);
assert.equal((ssr.match(/data-row-id=/g) ?? []).length, 120, "public SSR renderer emits every body row");
assert.ok(ssr.includes("Row-119"));
assert.ok(!ssr.includes("markdown-table-spacer"));
assert.ok(!ssr.includes('data-table-virtualized="true"'));
assert.match(ssr, /<tr[^>]*data-static-row-presentation="true"/);
assert.match(ssr, /<(?:th|td)[^>]*data-static-cell-presentation="true"/);
// GFM 205: a table without body rows has no <tbody>, through the store path and the SSR blocks path.
const headerOnly = await compileMarkdownSnapshotDirect({
  text: "| abc | def |\n| --- | --- |\n",
  init: { schemaVersion: STREAM_MDX_SCHEMA_VERSION, docPlugins: { tables: true } },
});
for (const headerOnlySsr of [
  renderToStaticMarkup(<MarkdownBlocksRenderer blocks={[]} store={createRendererStore(headerOnly.blocks)} componentRegistry={new ComponentRegistry()} />),
  renderToStaticMarkup(<MarkdownBlocksRenderer blocks={headerOnly.blocks} componentRegistry={new ComponentRegistry()} />),
]) {
  assert.ok(headerOnlySsr.includes("<th"), "the header still renders");
  assert.ok(!headerOnlySsr.includes("<tbody"), "a table without rows has no body section");
}

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
const rowTopById = new Map<string, number>();
let usePhysicalRowFlow = false;
const physicalRowTop = (row: HTMLTableRowElement): number => {
  const table = row.closest("table");
  if (!table) return 0;
  let top = table.tHead?.getBoundingClientRect().height ?? 0;
  for (let sectionIndex = 0; sectionIndex < table.tBodies.length; sectionIndex++) {
    const tbody = table.tBodies.item(sectionIndex);
    if (!tbody) continue;
    for (let rowIndex = 0; rowIndex < tbody.rows.length; rowIndex++) {
      const precedingRow = tbody.rows.item(rowIndex);
      if (!precedingRow) continue;
      if (precedingRow === row) {
        const viewport = table.closest('[data-table-virtualized="true"]') as HTMLDivElement | null;
        return (viewport?.getBoundingClientRect().top ?? 0) + (viewport?.clientTop ?? 0) + top -
          (viewport?.scrollTop ?? 0);
      }
      const precedingRowId = precedingRow.dataset.rowId;
      if (precedingRowId) {
        top += rowHeightById.get(precedingRowId) ?? changedRowHeight;
      } else {
        const spacerHeight = Number.parseFloat(precedingRow.style.height);
        if (Number.isFinite(spacerHeight)) top += spacerHeight;
      }
    }
  }
  return 0;
};
// Enabled only after afterprint restores the bounded viewport, so geometry walks
// the actual rendered rows and spacers without scanning 10,000 print rows per rect.
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
  const top = rowId ? rowTopById.get(rowId) ?? (usePhysicalRowFlow ? physicalRowTop(this) : 0) : 0;
  return new dom.window.DOMRect(0, top, availableWidth, height);
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
container.style.setProperty("overflow", "auto");
const root = createRoot(container);
const markdown = ["| ID | Description |", "| --- | --- |", ...Array.from({ length: 120 }, (_, index) => `| Row-${index} | Description-${index} |`)].join("\n");
const handle = React.createRef<StreamingMarkdownHandle>();
const customTablePresentation = {
  table: {
    wrapper: ({ children }: { children?: React.ReactNode }) => (
      <div className="relative w-full overflow-auto" style={{ overflow: "auto", overflowX: "scroll", color: "rgb(10, 20, 30)" }}
        data-custom-wrapper="true">{children}</div>
    ),
  },
  "table-row": { props: { "data-stream-row-presentation": "true" } },
  "table-cell": { props: { "data-stream-cell-presentation": "true" } },
};
const replacementTablePresentation = {
  table: {
    wrapper: ({ children }: { children?: React.ReactNode }) => (
      <div className="relative w-full overflow-auto" style={{ overflow: "auto" }}
        data-custom-wrapper="true" data-adapter="replacement">{children}</div>
    ),
  },
};
const features = { tables: true };
const render = (tableVirtualization?: TableVirtualizationOptions, components = customTablePresentation) => root.render(
  <StreamingMarkdown ref={handle} engine="main" text={markdown} features={features} caret={false}
    components={components} tableVirtualization={tableVirtualization} />,
);
const rows = () => Array.from(container.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row-id]"));
const scrollContainer = () => container.querySelector<HTMLDivElement>('[data-table-virtualized="true"]');

try {
  render();
  await waitFor(() => rows().length === 120, "default public consumer renders all rows");
  await handle.current?.waitForIdle();
  assert.equal(scrollContainer(), null, "virtualization is opt-in");
  const firstId = rows()[0].dataset.rowId;
  assert.equal(rows()[0]?.dataset.streamRowPresentation, "true",
    "streamed rows consult the table-row presentation");
  assert.equal(rows()[0]?.querySelector("td")?.getAttribute("data-stream-cell-presentation"), "true",
    "streamed cells consult the table-cell presentation");

  render({ minRows: 40, estimatedRowHeight: 40, overscan: 2, maxHeight: "240px" });
  await waitFor(() => Boolean(scrollContainer()), "config changes enable virtualization without new text");
  const viewport = scrollContainer();
  assert.ok(viewport);
  assert.equal(viewport.style.maxHeight, "240px");
  assert.ok(rows().length < 120);
  assert.ok(rows().length >= 10,
    "string maxHeight keeps an initial finite row window before ResizeObserver reports geometry");
  assert.equal(rows()[0].dataset.rowId, firstId, "row IDs survive full-to-windowed rendering");
  assert.equal(rows()[0]?.dataset.streamRowPresentation, "true",
    "virtualized rows consult the table-row presentation");
  assert.equal(rows()[0]?.querySelector("td")?.getAttribute("data-stream-cell-presentation"), "true",
    "virtualized cells consult the table-cell presentation");
  assert.equal(container.querySelectorAll("table").length, 1, "the native table remains present inside its presentation");
  assert.equal(container.querySelectorAll("thead").length, 1);
  assert.ok(container.querySelector('[data-custom-wrapper="true"] table'));
  assert.equal(container.querySelector("thead")?.style.position, "sticky");
  assert.equal(container.querySelector("thead")?.style.backgroundColor, "var(--stream-mdx-table-header-background, Canvas)");
  const customWrapper = container.querySelector<HTMLElement>('[data-custom-wrapper="true"]');
  assert.ok(customWrapper);
  assert.equal(customWrapper.style.getPropertyValue("overflow"), "visible");
  assert.equal(customWrapper.style.getPropertyPriority("overflow"), "important");
  assert.equal(container.style.overflow, "auto", "consumer ancestors outside the table block stay untouched");
  assert.deepEqual(Array.from(container.querySelectorAll<HTMLTableColElement>("col"), (col) => col.style.width), ["80px", "720px"]);
  assert.ok((naturalPassRowCounts[naturalPassRowCounts.length - 1] ?? Infinity) <= 64,
    "initial natural column measurement uses only a bounded first row chunk");
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
  assert.ok((naturalPassRowCounts[naturalPassRowCounts.length - 1] ?? Infinity) <= 64,
    "viewport resize measures columns without mounting the entire table");

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
  assert.equal(customWrapper.isConnected, true, "the native table presentation wrapper remains mounted when virtualization is disabled");
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
  assert.ok((naturalPassRowCounts[naturalPassRowCounts.length - 1] ?? Infinity) <= 64,
    "same-width re-enable measures columns from a bounded row chunk");
  const oldAdapter = container.querySelector<HTMLElement>('[data-custom-wrapper="true"]');
  assert.ok(oldAdapter?.isConnected);
  const oldNativeTable = container.querySelector("table");
  const swappedObserverCallbacks = Array.from(TestResizeObserver.instances);
  render({ minRows: 40, estimatedRowHeight: 40, overscan: 2, maxHeight: 240 }, replacementTablePresentation);
  await waitFor(() => Boolean(container.querySelector<HTMLElement>('[data-adapter="replacement"]')),
    "replacement table presentation mounts without changing virtualization");
  await waitFor(() => rows().length === 7 && Array.from(TestResizeObserver.instances).every((observer) =>
    Array.from(observer.targets).every((target) => target.isConnected && container.contains(target))),
    "table/header/row observers target only current connected DOM");
  assert.notEqual(container.querySelector("table"), oldNativeTable);
  assert.equal(oldAdapter.isConnected, false);
  assert.equal(oldAdapter.style.overflow, "auto", "detached old adapter receives its original overflow");
  const liveReplacement = container.querySelector<HTMLElement>('[data-adapter="replacement"]');
  assert.ok(liveReplacement?.isConnected);
  assert.equal(liveReplacement.style.overflow, "visible");
  assert.equal(liveReplacement.style.getPropertyPriority("overflow"), "important");
  for (const observer of swappedObserverCallbacks) observer.deliverPending();
  assert.equal(rows().length, 7, "queued old observer callbacks cannot change the new measurement generation");
  liveReplacement.style.setProperty("overflow", "hidden", "important");
  render(undefined, replacementTablePresentation);
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
  const activeLegacyRoot = createRoot(container);
  activeLegacyRoot.render(
    <StreamingActivityContext.Provider value={true}>
      <SourceMarkdownBlocksRenderer blocks={[block]} componentRegistry={registry} />
    </StreamingActivityContext.Provider>,
  );
  await waitFor(() => rows().length === 120, "active legacy table mounts all rows before effect settlement");
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  assert.equal(scrollContainer(), null, "legacy finalized tables stay unvirtualized during active sessions");
  assert.equal(rows().length, 120);
  activeLegacyRoot.unmount();

  const inactiveLegacyRoot = createRoot(container);
  inactiveLegacyRoot.render(
    <StreamingActivityContext.Provider value={false}>
      <SourceMarkdownBlocksRenderer blocks={[block]} componentRegistry={registry} />
    </StreamingActivityContext.Provider>,
  );
  await waitFor(() => Boolean(scrollContainer()), "inactive finalized legacy tables remain eligible for windowing");
  const inactiveLegacyViewport = scrollContainer();
  assert.ok(inactiveLegacyViewport, "the cold fallback table exposes its public viewport");
  assert.ok(rows().length < 120, "the fallback viewport starts with a bounded row window");
  act(() => {
    dom.window.dispatchEvent(new dom.window.Event("beforeprint"));
    assert.equal(rows().length, 120, "beforeprint restores every row in the cold fallback table");
    assert.equal(dom.window.getComputedStyle(inactiveLegacyViewport).overflowY, "visible",
      "beforeprint removes vertical clipping from the cold fallback table");
    assert.equal(dom.window.getComputedStyle(inactiveLegacyViewport).maxHeight, "none",
      "beforeprint removes the fallback table's max-height");
  });
  act(() => dom.window.dispatchEvent(new dom.window.Event("afterprint")));
  await waitFor(() => rows().length < 120, "afterprint restores bounded fallback table rows");
  assert.equal(scrollContainer(), inactiveLegacyViewport, "print restoration keeps the fallback viewport owner");

  assert.ok(rows().length < 120);
  inactiveLegacyRoot.unmount();
  const streamingRoot = createRoot(container);
  const { promise: thresholdGate, resolve: releaseThreshold } = deferred<void>();
  const { promise: tailGate, resolve: releaseTail } = deferred<void>();
  const { promise: streamFinished, resolve: finishStream } = deferred<void>();
  const tableRows = (start: number, end: number) => Array.from(
    { length: end - start },
    (_, index) => `| Row-${start + index} | Description-${start + index} |`,
  ).join("\n");
  const stream = (async function* () {
    yield `| ID | Description |\n| --- | --- |\n${tableRows(0, 39)}\n`;
    await thresholdGate;
    yield `${tableRows(39, 40)}\n`;
    await tailGate;
    yield `${tableRows(40, 41)}\n`;
    await streamFinished;
  })();
  try {
    streamingRoot.render(<StreamingMarkdown ref={handle} engine="main" stream={stream} features={features}
      tableVirtualization={{ minRows: 40, estimatedRowHeight: 40, overscan: 2, maxHeight: 240 }} caret={false} />);
    await waitFor(() => container.textContent?.includes("Row-38") ?? false,
      "the first 39 authored rows render while the table is still below its windowing threshold");
    releaseThreshold();
    await waitFor(() => Boolean(scrollContainer()), "an open authored table activates windowing at 40 rows before stream EOF");
    const viewport = scrollContainer();
    assert.ok(viewport);
    await waitFor(() => rows().some((row) => row.textContent === "Row-0Description-0"),
      "the first literal table row remains correct after windowing activates");
    assert.ok(rows().length < 40, "the active table mounts a bounded viewport instead of all threshold rows");

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
    TestResizeObserver.notify();
    const anchorRow = rows().find((row) => row.textContent === "Row-3Description-3");
    assert.ok(anchorRow);
    const anchorId = anchorRow.dataset.rowId;
    assert.ok(anchorId);
    rowTopById.set(anchorId, 64);
    viewport.scrollTop = 120;
    viewport.dispatchEvent(new dom.window.Event("scroll"));
    await waitFor(() => rows().some((row) => row.dataset.rowId === anchorId),
      "the visible row anchor remains mounted after scrolling");
    const anchorTop = anchorRow.getBoundingClientRect().top - viewport.getBoundingClientRect().top;

    releaseTail();
    await waitFor(
      () => handle.current?.getState().blocks.some((entry) =>
        entry.type === "table" && entry.payload.raw.includes("Row-40")) ?? false,
      "the next authored table row reaches the still-open source before EOF",
    );
    const retainedAnchor = rows().find((row) => row.dataset.rowId === anchorId);
    assert.ok(retainedAnchor?.isConnected);
    assert.equal(retainedAnchor.textContent, "Row-3Description-3", "the earlier literal row content remains correct");
    assert.equal(retainedAnchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top, anchorTop,
      "the detached visible row anchor stays at the same viewport offset after the tail append");
    assert.equal(viewport.scrollTop, 120, "the tail append does not jump the user's scroll position");
    rowTopById.delete(anchorId);

    finishStream();
    await waitFor(() => handle.current?.getState().blocks.every((entry) => entry.isFinalized) ?? false,
      "automatic stream EOF finalizes every public block");
    assert.throws(
      () => handle.current?.append("\n\nImperative content after EOF"),
      (error: unknown) => error instanceof Error && "reason" in error && error.reason === "sealed",
      "automatic stream EOF seals the public source session",
    );
    assert.equal(container.textContent?.includes("Imperative content after EOF"), false);
  } finally {
    releaseThreshold();
    releaseTail();
    finishStream();
  }
  const { promise: largeStreamGate, resolve: releaseLargeStream } = deferred<void>();
  const largeTableStream = (async function* () {
    yield `| ID | Description |\n| --- | --- |\n${tableRows(0, 3)}\n| [Row-3](#table-focus-retention) | Description-3 |\n${tableRows(4, 10_000)}\n`;
    await largeStreamGate;
  })();
  availableWidth = 800;
  changedIdWidth = undefined;
  changedRowHeight = 40;
  rowHeightById.clear();
  rowTopById.clear();

  let peakCommittedBodyRows = 0;
  const bodyMutationObserver = new dom.window.MutationObserver(() => {
    peakCommittedBodyRows = Math.max(peakCommittedBodyRows, rows().length);
  });
  bodyMutationObserver.observe(container, { childList: true, subtree: true });
  const naturalLayoutStart = naturalPassRowCounts.length;
  try {
    streamingRoot.render(<StreamingMarkdown ref={handle} engine="main" stream={largeTableStream} features={features}
      tableVirtualization={{ minRows: 40, estimatedRowHeight: 40, overscan: 2, maxHeight: 240 }} caret={false} />);
    await waitFor(() => {
      const viewport = scrollContainer();
      if (!viewport || viewport.getAttribute("data-table-total-rows") !== "10000") return false;
      const hasFirstLiteralRow = Array.from(
        viewport.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row-id]"),
      ).some((row) => row.textContent === "Row-0Description-0");
      const columnWidths = Array.from(
        viewport.querySelectorAll<HTMLTableColElement>("col"),
        (col) => col.style.width,
      );
      return hasFirstLiteralRow && columnWidths.length === 2 &&
        columnWidths[0] === "80px" && columnWidths[1] === "720px";
    }, "the complete 10,000-row source reaches a measured viewport with its first literal row");
    const largeViewport = scrollContainer();
    assert.ok(largeViewport);
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    peakCommittedBodyRows = Math.max(peakCommittedBodyRows, rows().length);
    const peakNaturalLayoutRows = Math.max(0, ...naturalPassRowCounts.slice(naturalLayoutStart));
    const initialPeakBodyRows = Math.max(peakCommittedBodyRows, peakNaturalLayoutRows);
    assert.ok(initialPeakBodyRows <= 64,
      `initial layout/measurement commit stays within one bounded native row chunk; observed ${initialPeakBodyRows}`);
    assert.deepEqual(Array.from(largeViewport.querySelectorAll<HTMLTableColElement>("col"), (col) => col.style.width),
      ["80px", "720px"], "header-derived column widths lock once the bounded viewport is measured");

    Object.defineProperty(largeViewport, "clientHeight", { configurable: true, value: 240 });
    Object.defineProperty(largeViewport, "clientWidth", { configurable: true, get: () => availableWidth });
    Object.defineProperty(largeViewport, "scrollHeight", {
      configurable: true,
      get: () => largeViewport.querySelector("table")?.getBoundingClientRect().height ?? 0,
    });
    let largeScrollTop = largeViewport.scrollTop;
    Object.defineProperty(largeViewport, "scrollTop", {
      configurable: true,
      get: () => largeScrollTop,
      set: (requested: number) => {
        largeScrollTop = Math.min(
          Math.max(0, requested),
          Math.max(0, largeViewport.scrollHeight - largeViewport.clientHeight),
        );
      },
    });
    const focusedRow = Array.from(
      largeViewport.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row-id]"),
    ).find((row) => row.textContent === "Row-3Description-3");
    assert.ok(focusedRow, "the initially bounded viewport renders the row with a native Markdown link");
    const earlyPinnedRowId = focusedRow.dataset.rowId;
    assert.ok(earlyPinnedRowId, "the focused native row has a stable public row identity");
    const initialTableExtent = largeViewport.scrollHeight;
    const nonPowerOfTwoRow = Array.from(
      largeViewport.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row-id]"),
    ).find((row) => row.textContent === "Row-2Description-2");
    assert.ok(nonPowerOfTwoRow);
    const nonPowerOfTwoRowId = nonPowerOfTwoRow.dataset.rowId;
    assert.ok(nonPowerOfTwoRowId);
    act(() => {
      rowHeightById.set(nonPowerOfTwoRowId, 80);
      TestResizeObserver.notify();
    });
    assert.equal(largeViewport.scrollHeight, initialTableExtent + 40,
      "a non-power-of-two measured row updates the indexed table extent");
    act(() => {
      rowHeightById.set(earlyPinnedRowId, 20);
      TestResizeObserver.notify();
    });
    assert.equal(largeViewport.scrollHeight, initialTableExtent + 20,
      "the focused row's measured height updates the same indexed extent");
    const focusedLink = focusedRow.querySelector<HTMLAnchorElement>('a[href="#table-focus-retention"]');
    assert.ok(focusedLink, "the fixture row contains a real rendered Markdown link");
    focusedLink.focus();
    assert.equal(dom.window.document.activeElement, focusedLink, "the real table link receives DOM focus");

    largeViewport.scrollTop = Number.MAX_SAFE_INTEGER;
    largeViewport.dispatchEvent(new dom.window.Event("scroll"));
    await waitFor(() => Array.from(
      largeViewport.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row-id]"),
    ).some((row) => row.textContent === "Row-9999Description-9999"),
    "the tail of the authored 10,000-row source remains reachable through the viewport");
    const measuredTailRow = Array.from(
      largeViewport.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row-id]"),
    ).find((row) => row.textContent === "Row-9999Description-9999");
    assert.ok(measuredTailRow);
    const measuredTailRowId = measuredTailRow.dataset.rowId;
    assert.ok(measuredTailRowId);
    const extentBeforeTailMeasurement = largeViewport.scrollHeight;
    act(() => {
      rowHeightById.set(measuredTailRowId, 80);
      TestResizeObserver.notify();
    });
    assert.equal(largeViewport.scrollHeight, extentBeforeTailMeasurement + 40,
      "the final indexed row measurement expands the public scroll extent");
    largeViewport.scrollTop = 0;
    largeViewport.dispatchEvent(new dom.window.Event("scroll"));
    await waitFor(() => !measuredTailRow.isConnected,
      "the measured final row unmounts after scrolling back to the viewport start");
    assert.equal(largeViewport.scrollHeight, extentBeforeTailMeasurement + 40,
      "the measured final row remains included in the scroll extent after unmounting");
    largeViewport.scrollTop = 4_020;
    largeViewport.dispatchEvent(new dom.window.Event("scroll"));
    await waitFor(() => Array.from(
      largeViewport.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row-id]"),
    ).some((row) => row.textContent === "Row-98Description-98"),
    "an exact row-height boundary selects the expected overscanned start");
    assert.equal(Array.from(
      largeViewport.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row-id]"),
    ).some((row) => row.textContent === "Row-97Description-97"), false,
    "an exact row-height boundary does not include the previous overscan row");
    assert.equal(
      largeViewport.getAttribute("data-table-mounted-rows"),
      String(largeViewport.querySelectorAll("tbody tr[data-row-id]").length),
      "the public mounted-row count agrees with rendered source rows",
    );
    assert.ok(focusedRow.isConnected, "the focused row remains connected after scrolling to the tail");
    assert.ok(focusedLink.isConnected, "the same focused Markdown link remains connected");
    assert.equal(dom.window.document.activeElement, focusedLink, "tail scrolling preserves focus on the same link");
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    peakCommittedBodyRows = Math.max(peakCommittedBodyRows, rows().length);
    assert.ok(peakCommittedBodyRows <= 65,
      `tail scrolling retains focus within a bounded native body row DOM; observed ${peakCommittedBodyRows}`);
    largeViewport.scrollTop = 0;
    largeViewport.dispatchEvent(new dom.window.Event("scroll"));
    await waitFor(() => {
      const visibleRows = largeViewport.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row-id]");
      return Array.from(visibleRows).some((row) => row.textContent === "Row-3Description-3") &&
        Array.from(visibleRows).some((row) => row.textContent === "Row-4Description-4");
    }, "returning to the viewport start restores the native selection endpoints");
    focusedLink.blur();
    assert.notEqual(dom.window.document.activeElement, focusedLink, "the old focused link is blurred before selecting text");

    const row4 = Array.from(
      largeViewport.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row-id]"),
    ).find((row) => row.textContent === "Row-4Description-4");
    assert.ok(row4);
    const selectionStart = focusedLink.firstChild;
    const selectionEnd = row4.cells.item(1)?.firstChild;
    assert.ok(selectionStart && selectionStart.nodeType === dom.window.Node.TEXT_NODE);
    assert.ok(selectionEnd && selectionEnd.nodeType === dom.window.Node.TEXT_NODE);
    const documentSelection = dom.window.getSelection();
    assert.ok(documentSelection);
    const selectionRange = dom.window.document.createRange();
    selectionRange.setStart(selectionStart, 0);
    selectionRange.setEnd(selectionEnd, selectionEnd.textContent?.length ?? 0);
    documentSelection.removeAllRanges();
    documentSelection.addRange(selectionRange);
    dom.window.document.dispatchEvent(new dom.window.Event("selectionchange"));
    assert.equal(documentSelection.anchorNode, selectionStart);
    assert.equal(documentSelection.focusNode, selectionEnd);

    largeViewport.scrollTop = Number.MAX_SAFE_INTEGER;
    largeViewport.dispatchEvent(new dom.window.Event("scroll"));
    await waitFor(() => Array.from(
      largeViewport.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row-id]"),
    ).some((row) => row.textContent === "Row-9999Description-9999"),
    "the tail remains reachable while a native text selection spans earlier rows");
    assert.ok(selectionStart.isConnected, "the selected row-3 link text remains connected");
    assert.ok(selectionEnd.isConnected, "the selected row-4 cell text remains connected");
    assert.equal(documentSelection.anchorNode, selectionStart, "selection anchor remains the original text node");
    assert.equal(documentSelection.focusNode, selectionEnd, "selection focus remains the original text node");
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    peakCommittedBodyRows = Math.max(peakCommittedBodyRows, rows().length);
    assert.ok(peakCommittedBodyRows <= 66,
      `two selected endpoints remain mounted within a bounded native body row DOM; observed ${peakCommittedBodyRows}`);
    const fullContentButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.getAttribute("aria-label")?.trim() === "Show full content" ||
        button.textContent?.trim() === "Show full content",
    );
    assert.ok(fullContentButton, "the native table exposes an accessible full-content control");
    assert.equal(fullContentButton.type, "button");
    assert.equal(fullContentButton.getAttribute("aria-pressed"), "false");
    const controlledIds = fullContentButton.getAttribute("aria-controls");
    assert.ok(controlledIds, "the full-content control identifies its table viewport");
    assert.ok(controlledIds.split(/\s+/).some((id) => {
      const region = dom.window.document.getElementById(id);
      return Boolean(region && (
        region === largeViewport || region.contains(largeViewport) || largeViewport.contains(region)
      ));
    }), "aria-controls references the rendered native table viewport");

    const nativeTable = largeViewport.querySelector("table");
    assert.ok(nativeTable);
    const nativeTableBody = nativeTable.querySelector("tbody");
    assert.ok(nativeTableBody);
    const selectedStartRow = selectionStart.parentElement?.closest("tr[data-row-id]");
    const selectedEndRow = selectionEnd.parentElement?.closest("tr[data-row-id]");
    assert.ok(selectedStartRow);
    assert.ok(selectedEndRow);
    assert.equal(selectedStartRow, focusedRow);
    assert.equal(selectedEndRow, row4);
    assert.equal(selectedStartRow.parentElement, nativeTableBody);
    assert.equal(selectedEndRow.parentElement, nativeTableBody);
    const largeBodyRows = () => largeViewport.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row-id]");
    const tailAnchorRow = Array.from(largeBodyRows()).find(
      (row) => row.textContent === "Row-9999Description-9999",
    );
    assert.ok(tailAnchorRow);
    const scrollTopBeforeFullContent = largeViewport.scrollTop;
    const tailAnchorTop = tailAnchorRow.getBoundingClientRect().top - largeViewport.getBoundingClientRect().top;

    fullContentButton.click();
    await waitFor(() => {
      const renderedRows = largeBodyRows();
      return fullContentButton.getAttribute("aria-pressed") === "true" && renderedRows.length === 10_000 &&
        Array.from(renderedRows).some((row) => row.textContent === "Row-0Description-0") &&
        Array.from(renderedRows).some((row) => row.textContent === "Row-9999Description-9999");
    }, "explicit full-content mode mounts every authored table body row");
    const fullContentRows = largeBodyRows();
    assert.equal(fullContentRows.length, 10_000);
    assert.equal(fullContentButton.getAttribute("aria-pressed"), "true");
    assert.equal(scrollContainer(), largeViewport, "full-content mode keeps the same native viewport");
    assert.equal(largeViewport.querySelector("table"), nativeTable, "full-content mode keeps the same native table");
    assert.equal(nativeTable.querySelector("tbody"), nativeTableBody, "full-content mode keeps the same table body");
    assert.equal(fullContentRows[fullContentRows.length - 1], tailAnchorRow,
      "the tail reader anchor keeps its native row node");
    assert.ok(tailAnchorRow.isConnected);
    assert.equal(tailAnchorRow.getBoundingClientRect().top - largeViewport.getBoundingClientRect().top, tailAnchorTop);
    assert.ok(selectionStart.isConnected, "full-content mode retains the original selection anchor text node");
    assert.ok(selectionEnd.isConnected, "full-content mode retains the original selection focus text node");
    assert.equal(documentSelection.anchorNode, selectionStart);
    assert.equal(documentSelection.focusNode, selectionEnd);
    assert.equal(selectionStart.parentElement?.closest("tr[data-row-id]"), selectedStartRow);
    assert.equal(selectionEnd.parentElement?.closest("tr[data-row-id]"), selectedEndRow);
    assert.equal(selectedStartRow.parentElement, nativeTableBody);
    assert.equal(selectedEndRow.parentElement, nativeTableBody);
    assert.deepEqual(Array.from(largeViewport.querySelectorAll<HTMLTableColElement>("col"), (col) => col.style.width),
      ["80px", "720px"], "explicit full-content mode retains the measured column widths");
    assert.equal(largeViewport.scrollTop, scrollTopBeforeFullContent, "full-content mode preserves the reader scroll position");

    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    peakCommittedBodyRows = 0;
    assert.ok(fullContentButton.isConnected, "the same control remains available to return to the bounded viewport");
    fullContentButton.click();
    await waitFor(() => {
      const renderedRows = largeBodyRows();
      return fullContentButton.getAttribute("aria-pressed") === "false" && renderedRows.length <= 66 &&
        Array.from(renderedRows).some((row) => row.textContent === "Row-9999Description-9999");
    }, "the same control restores a bounded viewport at the existing reader anchor");
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    peakCommittedBodyRows = Math.max(peakCommittedBodyRows, rows().length);
    assert.ok(peakCommittedBodyRows <= 66,
      `returning from explicit full-content mode stays within a bounded native body row DOM; observed ${peakCommittedBodyRows}`);
    assert.equal(fullContentButton.getAttribute("aria-pressed"), "false");
    assert.equal(scrollContainer(), largeViewport, "returning to the viewport keeps the same native scroll container");
    assert.equal(largeViewport.querySelector("table"), nativeTable, "returning to the viewport keeps the same native table");
    assert.equal(nativeTable.querySelector("tbody"), nativeTableBody, "returning to the viewport keeps the same table body");
    assert.equal(Array.from(largeBodyRows()).find((row) => row.textContent === "Row-9999Description-9999"),
      tailAnchorRow, "the tail reader anchor retains its row identity");
    assert.ok(tailAnchorRow.isConnected);
    assert.equal(tailAnchorRow.getBoundingClientRect().top - largeViewport.getBoundingClientRect().top, tailAnchorTop);
    assert.ok(selectionStart.isConnected, "bounded mode retains the original selection anchor text node");
    assert.ok(selectionEnd.isConnected, "bounded mode retains the original selection focus text node");
    assert.equal(documentSelection.anchorNode, selectionStart);
    assert.equal(documentSelection.focusNode, selectionEnd);
    assert.equal(selectionStart.parentElement?.closest("tr[data-row-id]"), selectedStartRow);
    assert.equal(selectionEnd.parentElement?.closest("tr[data-row-id]"), selectedEndRow);
    assert.equal(selectedStartRow.parentElement, nativeTableBody);
    assert.equal(selectedEndRow.parentElement, nativeTableBody);
    assert.equal(largeViewport.scrollTop, scrollTopBeforeFullContent, "returning to the viewport preserves the reader scroll position");
    assert.deepEqual(Array.from(largeViewport.querySelectorAll<HTMLTableColElement>("col"), (col) => col.style.width),
      ["80px", "720px"], "returning to the viewport retains the measured column widths");

    act(() => {
      dom.window.dispatchEvent(new dom.window.Event("beforeprint"));
      const synchronousPrintRows = largeBodyRows();
      assert.equal(synchronousPrintRows.length, 10_000,
        "beforeprint synchronously commits every table body row before the print snapshot");
      assert.ok(Array.from(synchronousPrintRows).some((row) => row.textContent === "Row-0Description-0"));
      assert.ok(Array.from(synchronousPrintRows).some((row) => row.textContent === "Row-9999Description-9999"));
      const ownerWindow = largeViewport.ownerDocument.defaultView;
      assert.ok(ownerWindow);
      const printViewportStyle = ownerWindow.getComputedStyle(largeViewport);
      const maxHeight = printViewportStyle.maxHeight.trim().toLowerCase();
      const overflowY = printViewportStyle.overflowY.trim().toLowerCase();
      const hasFiniteMaxHeight = maxHeight !== "none" && Number.isFinite(Number.parseFloat(maxHeight));
      const clipsOverflow = /^(auto|scroll|hidden|clip)$/.test(overflowY);
      assert.ok(!(hasFiniteMaxHeight && clipsOverflow),
        `beforeprint must not leave the table viewport vertically clipped; got max-height=${JSON.stringify(printViewportStyle.maxHeight)} overflow-y=${JSON.stringify(printViewportStyle.overflowY)}`);
    });
    const printRows = largeBodyRows();
    assert.equal(printRows.length, 10_000);
    assert.ok(Array.from(printRows).some((row) => row.textContent === "Row-0Description-0"));
    assert.ok(Array.from(printRows).some((row) => row.textContent === "Row-9999Description-9999"));
    assert.equal(scrollContainer(), largeViewport, "print preparation keeps the native viewport");
    assert.equal(largeViewport.querySelector("table"), nativeTable, "print preparation keeps the native table");
    assert.equal(nativeTable.querySelector("tbody"), nativeTableBody, "print preparation keeps the native table body");
    assert.equal(Array.from(printRows).find((row) => row.textContent === "Row-9999Description-9999"), tailAnchorRow);
    assert.ok(selectionStart.isConnected, "print preparation keeps the original selection anchor text node");
    assert.ok(selectionEnd.isConnected, "print preparation keeps the original selection focus text node");
    assert.equal(documentSelection.anchorNode, selectionStart);
    assert.equal(documentSelection.focusNode, selectionEnd);
    assert.equal(selectionStart.parentElement?.closest("tr[data-row-id]"), selectedStartRow);
    assert.equal(selectionEnd.parentElement?.closest("tr[data-row-id]"), selectedEndRow);
    assert.equal(fullContentButton.getAttribute("aria-pressed"), "false",
      "print preparation does not change the user's manual full-content mode");
    assert.deepEqual(Array.from(largeViewport.querySelectorAll<HTMLTableColElement>("col"), (col) => col.style.width),
      ["80px", "720px"], "print preparation retains measured column widths");

    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    peakCommittedBodyRows = 0;
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("afterprint"));
    });
    await waitFor(() => {
      const restoredRows = largeBodyRows();
      return fullContentButton.getAttribute("aria-pressed") === "false" && restoredRows.length <= 66 &&
        Array.from(restoredRows).some((row) => row.textContent === "Row-9999Description-9999");
    }, "the native afterprint event restores the bounded viewport at the reader anchor");
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    peakCommittedBodyRows = Math.max(peakCommittedBodyRows, rows().length);
    assert.ok(peakCommittedBodyRows <= 66,
      `afterprint returns to a bounded native body row DOM; observed ${peakCommittedBodyRows}`);
    assert.equal(fullContentButton.getAttribute("aria-pressed"), "false");
    assert.equal(scrollContainer(), largeViewport, "afterprint keeps the native viewport");
    assert.equal(largeViewport.querySelector("table"), nativeTable, "afterprint keeps the native table");
    assert.equal(nativeTable.querySelector("tbody"), nativeTableBody, "afterprint keeps the native table body");
    assert.equal(Array.from(largeBodyRows()).find((row) => row.textContent === "Row-9999Description-9999"),
      tailAnchorRow, "afterprint preserves the tail reader anchor row");
    assert.ok(tailAnchorRow.isConnected);
    assert.equal(tailAnchorRow.getBoundingClientRect().top - largeViewport.getBoundingClientRect().top, tailAnchorTop);
    assert.ok(selectionStart.isConnected, "afterprint retains the original selection anchor text node");
    assert.ok(selectionEnd.isConnected, "afterprint retains the original selection focus text node");
    assert.equal(documentSelection.anchorNode, selectionStart);
    assert.equal(documentSelection.focusNode, selectionEnd);
    assert.equal(selectionStart.parentElement?.closest("tr[data-row-id]"), selectedStartRow);
    assert.equal(selectionEnd.parentElement?.closest("tr[data-row-id]"), selectedEndRow);
    assert.equal(selectedStartRow.parentElement, nativeTableBody);
    assert.equal(selectedEndRow.parentElement, nativeTableBody);
    assert.equal(largeViewport.scrollTop, scrollTopBeforeFullContent, "afterprint preserves the reader scroll position");
    assert.deepEqual(Array.from(largeViewport.querySelectorAll<HTMLTableColElement>("col"), (col) => col.style.width),
      ["80px", "720px"], "afterprint retains the measured column widths");
    assert.equal(rowHeightById.get(earlyPinnedRowId), 20, "the earlier native selection row has a 20px baseline");
    usePhysicalRowFlow = true;
    await act(async () => {
      TestResizeObserver.notify();
    });
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    const restoredFarAnchorRow = Array.from(largeBodyRows()).find(
      (row) => row.textContent === "Row-9999Description-9999",
    );
    assert.ok(restoredFarAnchorRow, "afterprint keeps the far reader anchor mounted beside native selection");
    const restoredFarAnchorTop = restoredFarAnchorRow.getBoundingClientRect().top -
      largeViewport.getBoundingClientRect().top;
    const restoredScrollTop = largeViewport.scrollTop;
    const selectionAnchorOffset = documentSelection.anchorOffset;
    const selectionFocusOffset = documentSelection.focusOffset;
    assert.equal(Array.from(largeBodyRows()).some((row) => row === restoredFarAnchorRow), true,
      "the captured far reader anchor is the same mounted DOM row");
    assert.equal(Array.from(largeBodyRows()).some((row) => row === selectedStartRow), true,
      "the original early native selection anchor row stays mounted");
    assert.equal(Array.from(largeBodyRows()).some((row) => row === selectedEndRow), true,
      "the original early native selection focus row stays mounted");

    rowHeightById.set(earlyPinnedRowId, 80);
    await act(async () => {
      TestResizeObserver.notify();
    });
    await waitFor(() => Array.from(largeBodyRows()).some((row) => row === restoredFarAnchorRow) &&
      largeViewport.scrollTop === restoredScrollTop + 60,
    "resizing an earlier pinned row preserves the far reader anchor with exact scroll compensation");
    assert.equal(Array.from(largeBodyRows()).some((row) => row === restoredFarAnchorRow), true,
      "the far reader anchor retains the same DOM node after the earlier row resize");
    assert.equal(restoredFarAnchorRow.getBoundingClientRect().top - largeViewport.getBoundingClientRect().top,
      restoredFarAnchorTop, "the far reader anchor keeps its exact viewport top offset");
    assert.equal(largeViewport.scrollTop, restoredScrollTop + 60,
      "scrollTop compensates for the independent 20px-to-80px physical height delta");
    assert.ok(largeBodyRows().length <= 66,
      `resizing an earlier pinned row keeps body DOM bounded; observed ${largeBodyRows().length}`);
    assert.equal(selectionStart.isConnected, true, "the original native selection anchor remains connected");
    assert.equal(selectionEnd.isConnected, true, "the original native selection focus remains connected");
    assert.equal(documentSelection.anchorNode === selectionStart, true,
      "the native selection anchor node is unchanged after the row resize");
    assert.equal(documentSelection.anchorOffset, selectionAnchorOffset,
      "the native selection anchor offset is unchanged after the row resize");
    assert.equal(documentSelection.focusNode === selectionEnd, true,
      "the native selection focus node is unchanged after the row resize");
    assert.equal(documentSelection.focusOffset, selectionFocusOffset,
      "the native selection focus offset is unchanged after the row resize");
    assert.equal(selectionStart.parentElement?.closest("tr[data-row-id]") === selectedStartRow, true);
    assert.equal(selectionEnd.parentElement?.closest("tr[data-row-id]") === selectedEndRow, true);
    usePhysicalRowFlow = false;
    largeViewport.scrollTop = 4_000;
    largeViewport.dispatchEvent(new dom.window.Event("scroll"));
    await waitFor(() => Array.from(largeBodyRows()).some((row) => row.dataset.rowIndex === "100"),
      "row 100 mounts before selecting its text");
    const boundaryRow = Array.from(largeBodyRows()).find((row) => row.dataset.rowIndex === "100");
    assert.ok(boundaryRow);
    const boundaryText = boundaryRow.cells.item(0)?.firstChild;
    assert.ok(boundaryText && boundaryText.nodeType === dom.window.Node.TEXT_NODE);
    const boundarySelection = dom.window.getSelection();
    assert.ok(boundarySelection);
    const boundaryRange = dom.window.document.createRange();
    boundaryRange.setStart(boundaryText, 0);
    boundaryRange.setEnd(boundaryText, boundaryText.textContent?.length ?? 0);
    act(() => {
      boundarySelection.removeAllRanges();
      boundarySelection.addRange(boundaryRange);
      dom.window.document.dispatchEvent(new dom.window.Event("selectionchange"));
    });

    // Rows 2 and 3 each have an extra 40px; with the 200px body viewport,
    // top=3,800 makes row 100 the first index after the window's exclusive end.
    largeViewport.scrollTop = 3_800;
    largeViewport.dispatchEvent(new dom.window.Event("scroll"));
    await waitFor(() => largeViewport.getAttribute("data-table-end-index") === "100" &&
      boundaryRow.isConnected,
    "a selected row exactly at the exclusive window boundary remains mounted");
    assert.equal(boundarySelection.anchorNode, boundaryText);
    assert.equal(boundarySelection.focusNode, boundaryText);
    assert.ok(largeBodyRows().length <= 66, "retaining a row after the visible window stays bounded");
    act(() => {
      boundarySelection.removeAllRanges();
      dom.window.document.dispatchEvent(new dom.window.Event("selectionchange"));
    });
    largeViewport.scrollTop = 0;
    largeViewport.dispatchEvent(new dom.window.Event("scroll"));
    await waitFor(() => !boundaryRow.isConnected, "clearing native selection releases the retained boundary row");
    largeViewport.scrollTop = Number.MAX_SAFE_INTEGER;
    largeViewport.dispatchEvent(new dom.window.Event("scroll"));
    await waitFor(() => Array.from(largeBodyRows()).some((row) => row.textContent === "Row-9999Description-9999"),
      "an out-of-range host scroll offset still pins the table window to its tail");
    const clampedTailStart = largeViewport.getAttribute("data-table-start-index");
    const clampedTailScrollTop = largeViewport.scrollTop;
    largeScrollTop = Number.MAX_SAFE_INTEGER;
    largeViewport.dispatchEvent(new dom.window.Event("scroll"));
    await waitFor(() => largeViewport.getAttribute("data-table-start-index") === clampedTailStart,
      "viewport math clamps an overscrolled host offset to the same tail window");
    largeScrollTop = clampedTailScrollTop;
    largeViewport.dispatchEvent(new dom.window.Event("scroll"));
  } finally {
    releaseLargeStream();
    bodyMutationObserver.disconnect();
  }
  await waitFor(() => handle.current?.getState().blocks.every((entry) => entry.isFinalized) ?? false,
    "the large stream reaches public EOF before the next lifecycle case");
  streamingRoot.render(<StreamingMarkdown ref={handle} engine="main" className="stream-removed" features={features} tableVirtualization={true} caret={false} />);
  await waitFor(() => Boolean(container.querySelector(".stream-removed")), "stream removal commits without replacing the renderer");
  handle.current?.restart();
  await waitFor(
    () => handle.current?.getState().workerReady === true && handle.current.getState().blocks.length === 0,
    "restart opens a fresh source session after stream removal",
  );
  handle.current?.append(`${markdown}\n\nImperative content after stream removal`);
  await waitFor(() => Boolean(scrollContainer()), "a restarted imperative table windows while its source remains open");
  assert.ok(rows().some((row) => row.textContent === "Row-0Description-0"),
    "the restarted imperative source still renders its earlier literal row");
  await handle.current?.finalize();
  await waitFor(() => Boolean(scrollContainer()), "finalize releases windowing for the post-removal imperative generation");
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
  streamingRoot.render(<StreamingMarkdown ref={handle} engine="main" stream={oldStream} features={features} tableVirtualization={true} caret={false} />);
  await waitFor(() => Boolean(scrollContainer()) && (container.textContent?.includes("Old iterator tail") ?? false),
    "old iterator renders its table through the active native viewport");
  assert.ok(rows().some((row) => row.textContent === "Row-0Description-0"));
  streamingRoot.render(<StreamingMarkdown ref={handle} engine="main" stream={newStream} features={features} tableVirtualization={true} caret={false} />);
  await waitFor(() => Boolean(scrollContainer()) && (container.textContent?.includes("New iterator tail") ?? false),
    "replacement iterator owns the active native viewport");
  assert.ok(rows().some((row) => row.textContent === "Row-0Description-0"));
  releaseOld();
  await oldFinished;
  await handle.current?.finalize();
  await waitFor(() => handle.current?.getState().blocks.every((entry) => entry.isFinalized) ?? false, "replacement iterator blocks finalize");
  assert.ok(scrollContainer(), "late cancelled iterator completion leaves the replacement table windowed");
  assert.equal(container.textContent?.includes("New iterator tail"), true);
  releaseNew();
  await waitFor(() => Boolean(scrollContainer()), "replacement iterator EOF releases its own session");
  streamingRoot.unmount();
  const imperativeRoot = createRoot(container);
  imperativeRoot.render(<StreamingMarkdown ref={handle} engine="main" features={features} tableVirtualization={true} caret={false} />);
  await waitFor(() => handle.current?.getState().workerReady ?? false, "imperative engine is ready");
  handle.current?.append(`${markdown}\n\n---\n\n`);
  await waitFor(() => Boolean(scrollContainer()), "imperative append windows a completed native table before source finalization");
  assert.ok(rows().some((row) => row.textContent === "Row-0Description-0"),
    "the active imperative source retains its earlier literal row");
  assert.ok(handle.current?.getState().blocks.some((entry) => entry.type === "table" && entry.isFinalized));
  await handle.current?.finalize();
  await waitFor(() => Boolean(scrollContainer()), "imperative finalization retains table windowing");
  assert.throws(
    () => handle.current?.append("\n\nAnother unfinished paragraph"),
    (error: unknown) => error instanceof Error && "reason" in error && error.reason === "sealed",
    "imperative input remains sealed after host finalization",
  );
  handle.current?.restart();
  await waitFor(
    () => handle.current?.getState().workerReady === true && handle.current.getState().blocks.length === 0,
    "restart opens a new imperative generation",
  );
  handle.current?.append(`${markdown}\n\nAnother unfinished paragraph`);
  await waitFor(
    () => Boolean(scrollContainer()) && container.textContent?.includes("Another unfinished paragraph") === true,
    "the restarted session keeps its native table windowed while rendering the active tail",
  );
  assert.ok(rows().some((row) => row.textContent === "Row-0Description-0"));
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
    externalWorker.postMessage({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: `${markdown}\n\nCaller-owned tail`, docPlugins: features });
    externalWorker.postMessage({ type: "FINALIZE" });
    await waitFor(() => Boolean(scrollContainer()), "caller initialization renders the managed table");
    assert.equal(externalInitializations, 1, "attachWorker skipInit preserves caller-owned initialization");
    handle.current?.append("\n\nManaged imperative content");
    await waitFor(() => Boolean(scrollContainer()) && (container.textContent?.includes("Managed imperative content") ?? false),
      "managed imperative append preserves the finalized native table viewport");
    assert.ok(rows().some((row) => row.textContent === "Row-0Description-0"));
    await handle.current?.finalize();
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
  // Controlled same-start document replacement must not inherit the old viewport geometry.
  const originalViewportTable = [
    "| Original ID | Original description |",
    "| --- | --- |",
    ...Array.from({ length: 120 }, (_, index) => `| Original-${index} | Original description-${index} |`),
  ].join("\n");
  const replacementViewportTable = [
    "| Current ID | Current description |",
    "| --- | --- |",
    ...Array.from({ length: 120 }, (_, index) => `| Current-${index} | Current description-${index} |`),
  ].join("\n");
  const replacementWorker = createInlineEngineWorker();
  const replacementWorkerFactory = () => replacementWorker;
  const replacementRoot = createRoot(container);
  const replacementVirtualization = { minRows: 40, estimatedRowHeight: 40, overscan: 2, maxHeight: 240 };
  const previousReplacementWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: NodeWorker });
  availableWidth = 800;
  changedIdWidth = 80;
  changedRowHeight = 40;
  rowHeightById.clear();
  rowTopById.clear();
  usePhysicalRowFlow = true;
  const publicFinalizedTableSource = () => {
    const blocks = handle.current?.getState().blocks;
    if (!blocks || blocks.length !== 1) return undefined;
    const [onlyBlock] = blocks;
    return onlyBlock?.type === "table" && onlyBlock.isFinalized ? onlyBlock.payload.raw : undefined;
  };
  const configureViewportGeometry = (viewport: HTMLDivElement) => {
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
  };
  try {
    replacementRoot.render(
      <StreamingMarkdown ref={handle} engine="worker" worker={replacementWorkerFactory} text={originalViewportTable}
        features={features} tableVirtualization={replacementVirtualization} caret={false} />,
    );
    await waitFor(() => publicFinalizedTableSource() === originalViewportTable,
      "the original controlled table reaches the public finalized snapshot");
    await handle.current?.waitForIdle();
    await waitFor(() => {
      const viewport = scrollContainer();
      return Boolean(viewport) && viewport?.getAttribute("data-table-total-rows") === "120" &&
        Array.from(viewport.querySelectorAll<HTMLTableColElement>("col"), (col) => col.style.width)
          .join(",") === "80px,720px";
    }, "the original native table has its bounded viewport and measured literal column widths");
    const originalViewport = scrollContainer();
    assert.ok(originalViewport);
    assert.equal(originalViewport.querySelectorAll("thead th, thead td").length, 2);
    configureViewportGeometry(originalViewport);
    await act(async () => {
      TestResizeObserver.notify();
    });
    assert.equal(originalViewport.scrollHeight, 4_840, "the original table starts with 120 ordinary 40px rows");

    originalViewport.scrollTop = 360;
    originalViewport.dispatchEvent(new dom.window.Event("scroll"));
    await waitFor(() => rows().some((row) => row.textContent === "Original-12Original description-12"),
      "scrolling makes an early original row available for native measurement");
    const measuredOriginalRow = rows().find((row) => row.textContent === "Original-12Original description-12");
    assert.ok(measuredOriginalRow);
    const measuredOriginalRowId = measuredOriginalRow.dataset.rowId;
    assert.ok(measuredOriginalRowId);
    rowHeightById.set(measuredOriginalRowId, 104);
    await act(async () => {
      TestResizeObserver.notify();
    });
    assert.equal(measuredOriginalRow.getBoundingClientRect().height, 104,
      "the early original row is physically measured taller than the 40px estimate");
    assert.equal(originalViewport.scrollHeight, 4_904,
      "the original public scroll extent includes the measured 104px row");

    originalViewport.scrollTop = 1_200;
    originalViewport.dispatchEvent(new dom.window.Event("scroll"));
    await waitFor(() => originalViewport.scrollTop > 0 &&
      !rows().some((row) => row.textContent === "Original-12Original description-12"),
    "the measured early row scrolls out of the original viewport");

    changedIdWidth = 120;
    rowHeightById.clear();
    rowTopById.clear();
    replacementRoot.render(
      <StreamingMarkdown ref={handle} engine="worker" worker={replacementWorkerFactory} text={replacementViewportTable}
        features={features} tableVirtualization={replacementVirtualization} caret={false} />,
    );
    await waitFor(() => publicFinalizedTableSource() === replacementViewportTable,
      "controlled replacement publishes the exact new finalized table source");
    await handle.current?.waitForIdle();
    await waitFor(() => Boolean(scrollContainer()), "the replacement table commits its native viewport");
    const replacementViewport = scrollContainer();
    assert.ok(replacementViewport);
    configureViewportGeometry(replacementViewport);
    await act(async () => {
      TestResizeObserver.notify();
    });
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() =>
      dom.window.requestAnimationFrame(() => resolve()),
    ));

    assert.equal(publicFinalizedTableSource(), replacementViewportTable,
      "the public table snapshot retains the exact replacement source");
    assert.equal(replacementViewport.scrollTop, 0, "a new document resets the native viewport to the top");
    assert.equal(replacementViewport.getAttribute("data-table-total-rows"), "120",
      "the replacement has the same 120 body rows");
    assert.equal(replacementViewport.querySelectorAll("thead th, thead td").length, 2,
      "the replacement has the same two columns");
    assert.deepEqual(Array.from(replacementViewport.querySelectorAll<HTMLTableColElement>("col"), (col) => col.style.width),
      ["120px", "680px"], "new-source natural column measurement replaces the prior literal widths");
    assert.equal(rows()[0]?.textContent, "Current-0Current description-0",
      "the replacement viewport starts with its new first body row, not the old scroll anchor");
    assert.equal(rows().length, 7, "the replacement uses ordinary-height rows rather than the old measured row height");
    assert.equal(
      replacementViewport.scrollHeight,
      4_840,
      "the replacement scroll extent excludes the obsolete 104px row measurement",
    );
  } finally {
    replacementRoot.unmount();
    replacementWorker.terminate();
    if (previousReplacementWorker) Object.defineProperty(globalThis, "Worker", previousReplacementWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
    usePhysicalRowFlow = false;
    availableWidth = 800;
    changedIdWidth = undefined;
    changedRowHeight = 40;
    rowHeightById.clear();
    rowTopById.clear();
  }
  // Native table Markdown copy must preserve the authored source at the public clipboard boundary.
  const authoredTable =
    "|  Item  | Notes |\r\n" +
    "| :---   |   ---: |\n" +
    "|  first  | plain \\| text |\r\n" +
    "| second | code `\\|` 🎉 |\n" +
    "|  third  | emoji 😀 |";
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const hadNavigator = typeof globalThis.navigator !== "undefined";
  const clipboardNavigator = globalThis.navigator ?? dom.window.navigator;
  const previousClipboard = Object.getOwnPropertyDescriptor(clipboardNavigator, "clipboard");
  let copiedMarkdown: string | undefined;
  if (!hadNavigator) {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: clipboardNavigator,
    });
  }
  Object.defineProperty(clipboardNavigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        copiedMarkdown = value;
      },
    },
  });
  const copyRoot = createRoot(container);
  try {
    copyRoot.render(<StreamingMarkdown ref={handle} engine="main" features={features} caret={false}
      controls={{ table: { copy: ["markdown"] } }} />);
    await waitFor(() => handle.current?.getState().workerReady ?? false, "native Markdown-copy renderer is ready");
    handle.current?.append(`${authoredTable}\r\n\nOutside the table.`);
    await waitFor(() => container.querySelector("table") !== null, "public append renders the authored GFM table");
    await handle.current?.finalize();
    await waitFor(
      () => container.querySelector<HTMLButtonElement>('button[data-stream-mdx-action="copy-markdown"]') !== null,
      "finalized native table exposes its Markdown copy button",
    );
    const copyButton = container.querySelector<HTMLButtonElement>('button[data-stream-mdx-action="copy-markdown"]');
    assert.ok(copyButton, "the public native table Markdown copy action is available");
    copyButton.click();
    await waitFor(() => copiedMarkdown !== undefined, "the native copy action writes to the browser clipboard");
    assert.equal(copiedMarkdown, authoredTable,
      "native Markdown copy preserves the authored table source and excludes the trailing paragraph");
    const coldTableBlock: Block = {
      id: "cold-authored-table",
      type: "table",
      isFinalized: true,
      payload: {
        raw: authoredTable,
        meta: {
          header: [[text("Item")], [text("Notes")]],
          rows: [
            [[text("first")], [text("plain | text")]],
            [[text("second")], [text("code | 🎉")]],
            [[text("third")], [text("emoji 😀")]],
          ],
        },
      },
    };
    const coldRegistry = new ComponentRegistry();
    coldRegistry.setControls({ table: { copy: ["markdown"], download: ["markdown"] } });
    const previousCreateObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const previousRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const previousAnchorClick = dom.window.HTMLAnchorElement.prototype.click;
    let downloadedBlob: Blob | null = null;
    let downloadName: string | null = null;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: (blob: Blob) => {
        downloadedBlob = blob;
        return "blob:cold-table";
      },
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
    dom.window.HTMLAnchorElement.prototype.click = function () {
      downloadName = this.download;
    };
    try {
      await act(async () => {
        copyRoot.render(
          <SourceMarkdownBlocksRenderer blocks={[coldTableBlock]} componentRegistry={coldRegistry} />,
        );
      });
      await waitFor(
        () => container.querySelector<HTMLButtonElement>('button[data-stream-mdx-action="copy-markdown"]') !== null,
        "the cold fallback table exposes Markdown copy",
      );
      copiedMarkdown = undefined;
      container.querySelector<HTMLButtonElement>('button[data-stream-mdx-action="copy-markdown"]')?.click();
      await waitFor(() => copiedMarkdown !== undefined, "the cold fallback copy writes to the browser clipboard");
      assert.equal(copiedMarkdown, authoredTable,
        "cold fallback Markdown copy preserves escaped pipes, inline Markdown, and authored CRLFs");
      const markdownDownloadButton = container.querySelector<HTMLButtonElement>(
        'button[data-stream-mdx-action="download-markdown"]',
      );
      assert.ok(markdownDownloadButton, "the cold fallback table exposes Markdown download");
      markdownDownloadButton.click();
      await waitFor(() => downloadedBlob !== null && downloadName !== null,
        "the cold fallback Markdown download is created");
      assert.equal(downloadName, "table.md");
      assert.ok(downloadedBlob);
      assert.deepEqual(Buffer.from(await downloadedBlob.arrayBuffer()), Buffer.from(authoredTable),
        "cold fallback Markdown download preserves the authored source slice");
    } finally {
      dom.window.HTMLAnchorElement.prototype.click = previousAnchorClick;
      if (previousCreateObjectURL) Object.defineProperty(URL, "createObjectURL", previousCreateObjectURL);
      else Reflect.deleteProperty(URL, "createObjectURL");
      if (previousRevokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", previousRevokeObjectURL);
      else Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  } finally {
    copyRoot.unmount();
    if (previousClipboard) Object.defineProperty(clipboardNavigator, "clipboard", previousClipboard);
    else Reflect.deleteProperty(clipboardNavigator, "clipboard");
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
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
