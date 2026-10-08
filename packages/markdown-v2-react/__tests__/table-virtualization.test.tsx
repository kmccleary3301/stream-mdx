import assert from "node:assert/strict";
import type { Block, InlineNode } from "@stream-mdx/core";
import { StreamingMarkdown, type StreamingMarkdownHandle, type TableElements, type TableVirtualizationOptions } from "@stream-mdx/react";
import { ComponentRegistry, MarkdownBlocksRenderer } from "@stream-mdx/react/server";
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
}

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
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

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
}

const container = dom.window.document.getElementById("root");
assert.ok(container);
const root = createRoot(container);
const markdown = ["| ID | Description |", "| --- | --- |", ...Array.from({ length: 120 }, (_, index) => `| Row-${index} | Description-${index} |`)].join("\n");
const handle = React.createRef<StreamingMarkdownHandle>();
const customElements: TableElements = {
  Table: (props) => <div data-custom-wrapper="true"><table {...props} data-custom="table" /></div>,
  Thead: (props) => <thead {...props} data-custom="thead" />,
  Tbody: (props) => <tbody {...props} data-custom="tbody" />,
  Tr: (props) => <tr {...props} data-custom="tr" />,
  Th: (props) => <th {...props} data-custom="th" />,
  Td: (props) => <td {...props} data-custom="td" />,
};
const features = { tables: true };
const render = (tableVirtualization?: TableVirtualizationOptions) => root.render(
  <StreamingMarkdown ref={handle} engine="main-thread" text={markdown} features={features} caret={false}
    tableElements={customElements} tableVirtualization={tableVirtualization} />,
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
  const spacer = container.querySelector("tr.markdown-table-spacer-bottom");
  assert.equal(spacer?.getAttribute("aria-hidden"), "true");
  assert.equal(spacer?.querySelector("td")?.colSpan, 2);

  // Six 40px visible rows plus two overscan rows. Measured 80px rows reduce the window.
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 240 });
  Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 800 });
  for (const row of rows()) {
    row.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 800, 80);
  }
  TestResizeObserver.notify();
  await waitFor(() => rows().length === 5, "ResizeObserver updates the window for variable row heights");
  assert.equal(rows()[0].dataset.rowId, firstId);

  viewport.scrollTop = 100000;
  viewport.dispatchEvent(new dom.window.Event("scroll"));
  await waitFor(() => container.textContent?.includes("Row-119") ?? false, "scroll beyond estimates still reaches the last row");
  assert.equal(container.querySelector(".markdown-table-spacer-bottom"), null);
  assert.ok(container.querySelector(".markdown-table-spacer-top"));

  render({ enabled: true, minRows: 40, overscan: 10000, maxHeight: 320 });
  await waitFor(() => viewport.style.maxHeight === "320px", "maxHeight config updates a mounted table");
  assert.ok(rows().length <= 60, "overscan is bounded to 50 rows at the bottom");
  render();
  await waitFor(() => rows().length === 120 && !scrollContainer(), "removing the config restores full rendering");

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
  const { promise: streamFinished, resolve: finishStream } = Promise.withResolvers<void>();
  const stream = (async function* () {
    yield `${markdown}\n`;
    await streamFinished;
  })();
  streamingRoot.render(<StreamingMarkdown ref={handle} engine="main-thread" stream={stream} features={features} tableVirtualization={true} caret={false} />);
  await waitFor(() => container.textContent?.includes("Row-119") ?? false, "active stream retains all table content");
  assert.equal(scrollContainer(), null, "unfinished stream must not virtualize its tail table");
  finishStream();
  handle.current?.finalize();
  await waitFor(() => Boolean(scrollContainer()), "finalization enables windowing of the streamed table");
  streamingRoot.unmount();
  assert.equal(TestResizeObserver.instances.size, 0, "unmount disconnects all table observers");
} finally {
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.window.close();
}
console.log("public table virtualization consumer tests passed");
