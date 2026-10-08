import assert from "node:assert";
import type { Block, InlineNode } from "@stream-mdx/core";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { ComponentRegistry } from "../src/components";
import { BlockNodeRenderer } from "../src/renderer/node-views";
import { createRendererStore } from "../src/renderer/store";
import { MarkdownBlocksRenderer } from "../src/server";
import type { TableElements } from "../src/types";

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function textNode(content: string): InlineNode {
  return { type: "text", text: content };
}

function createTestTableBlock(rowCount: number, isFinalized = true): Block {
  const header = [[textNode("ID")], [textNode("Title")], [textNode("Score")]];
  const rows = Array.from({ length: rowCount }, (_, i) => [
    [textNode(`Row-${i}`)],
    [textNode(i % 10 === 0 ? `Multiline Title for row ${i}\nSecond line\nThird line` : `Title for row ${i}`)],
    [textNode(`Score-${i * 100}`)],
  ]);

  return {
    id: "table-1",
    type: "table",
    isFinalized,
    payload: {
      raw: "| ID | Title | Score |\n| --- | --- | --- |\n" + rows.map((_, i) => `| Row-${i} | Title | Score |`).join("\n"),
      meta: {
        header,
        rows,
        align: ["left", "left", "right"],
      },
    },
  };
}

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function setupDomEnvironment() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const target = globalThis as unknown as Record<string, unknown>;
  target.window = window;
  target.document = window.document;
  target.HTMLElement = window.HTMLElement;
  target.HTMLTableElement = window.HTMLTableElement;
  target.HTMLTableRowElement = window.HTMLTableRowElement;
  target.HTMLTableCellElement = window.HTMLTableCellElement;
  target.Node = window.Node;
  target.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  target.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  target.ResizeObserver = MockResizeObserver;
  return { dom, window };
}

async function runTableVirtualizationTestSuite(): Promise<void> {
  console.log("Starting table virtualization test suite...");

  // 1. SSR Invariant: Full table rendered, zero spacer rows, all row data preserved
  {
    const block = createTestTableBlock(100, true);
    const registry = new ComponentRegistry({}, {}, {}, {
      tableVirtualization: { enabled: true, minRows: 20 },
    });

    const html = renderToStaticMarkup(
      React.createElement(MarkdownBlocksRenderer, {
        blocks: [block],
        componentRegistry: registry,
      }),
    );

    assert.ok(html.includes("<table"), "SSR output must contain <table>");
    assert.ok(html.includes("Row-0"), "SSR output must contain first row");
    assert.ok(html.includes("Row-99"), "SSR output must contain last row (Row-99)");
    assert.ok(html.includes("Row-50"), "SSR output must contain middle row (Row-50)");
    assert.strictEqual(
      html.includes("markdown-table-spacer"),
      false,
      "SSR output must NEVER contain spacer rows",
    );
    console.log("  [PASS] 1. SSR invariant: renders full table with all rows and no spacers");
  }

  // 2. Active Streaming Invariant: Unfinalized table renders all rows without virtualization
  {
    const { window } = setupDomEnvironment();
    const container = window.document.getElementById("root");
    assert.ok(container, "root container required");
    const block = createTestTableBlock(80, false); // isFinalized: false (streaming)
    const store = createRendererStore([block]);
    const registry = new ComponentRegistry({}, {}, {}, {
      tableVirtualization: { enabled: true, minRows: 20 },
    });

    const root = createRoot(container);
    root.render(React.createElement(BlockNodeRenderer, { store, blockId: block.id, registry }));
    await sleep(40);

    const table = container.querySelector("table");
    assert.ok(table, "expected table to render");
    assert.strictEqual(
      table.getAttribute("data-table-virtualized"),
      "false",
      "active streaming table must remain non-virtualized",
    );
    const rows = container.querySelectorAll("tbody tr");
    assert.strictEqual(rows.length, 80, "active streaming table must render all 80 rows in the DOM");
    assert.ok(container.textContent?.includes("Row-79"), "last row must be present during streaming");
    assert.strictEqual(
      container.querySelectorAll(".markdown-table-spacer").length,
      0,
      "active streaming table must not have spacer rows",
    );

    root.unmount();
    console.log("  [PASS] 2. Active streaming invariant: renders all rows without virtualization");
  }

  // 3. Conservative Default Invariant: Large finalized table without opt-in renders all rows
  {
    const { window } = setupDomEnvironment();
    const container = window.document.getElementById("root");
    assert.ok(container, "root container required");
    const block = createTestTableBlock(100, true);
    const store = createRendererStore([block]);
    const registry = new ComponentRegistry(); // default: tableVirtualization disabled

    const root = createRoot(container);
    root.render(React.createElement(BlockNodeRenderer, { store, blockId: block.id, registry }));
    await sleep(40);

    const table = container.querySelector("table");
    assert.ok(table, "expected table to render");
    assert.strictEqual(
      table.getAttribute("data-table-virtualized"),
      "false",
      "default conservative configuration must not virtualize tables",
    );
    const rows = container.querySelectorAll("tbody tr");
    assert.strictEqual(rows.length, 100, "default configuration must render all 100 rows");
    assert.strictEqual(
      container.querySelectorAll(".markdown-table-spacer").length,
      0,
      "default configuration must have zero spacer rows",
    );

    root.unmount();
    console.log("  [PASS] 3. Conservative default invariant: large table unchanged without opt-in");
  }

  // 4. Small Table Threshold Invariant: Tables under minRows render all rows
  {
    const { window } = setupDomEnvironment();
    const container = window.document.getElementById("root");
    assert.ok(container, "root container required");
    const block = createTestTableBlock(15, true);
    const store = createRendererStore([block]);
    const registry = new ComponentRegistry({}, {}, {}, {
      tableVirtualization: { enabled: true, minRows: 40 },
    });

    const root = createRoot(container);
    root.render(React.createElement(BlockNodeRenderer, { store, blockId: block.id, registry }));
    await sleep(40);

    const table = container.querySelector("table");
    assert.ok(table, "expected table to render");
    assert.strictEqual(
      table.getAttribute("data-table-virtualized"),
      "false",
      "small table under threshold must not virtualize",
    );
    const rows = container.querySelectorAll("tbody tr");
    assert.strictEqual(rows.length, 15, "small table must render all 15 rows");

    root.unmount();
    console.log("  [PASS] 4. Small table invariant: under threshold renders all rows");
  }

  // 5. Finalized Large Table Virtualization: Mounted browser virtualizes, renders windowed subset
  {
    const { window } = setupDomEnvironment();
    const container = window.document.getElementById("root");
    assert.ok(container, "root container required");
    const block = createTestTableBlock(100, true);
    const store = createRendererStore([block]);
    const registry = new ComponentRegistry({}, {}, {}, {
      tableVirtualization: {
        enabled: true,
        minRows: 25,
        estimatedRowHeight: 40,
        overscan: 6,
        maxHeight: "500px",
      },
    });

    const root = createRoot(container);
    root.render(React.createElement(BlockNodeRenderer, { store, blockId: block.id, registry }));
    await sleep(40);

    const scrollContainer = container.querySelector(".markdown-table-container");
    assert.ok(scrollContainer, "expected scroll container wrapper for virtualized table");
    assert.strictEqual(
      scrollContainer.getAttribute("data-table-virtualized"),
      "true",
      "expected data-table-virtualized='true'",
    );
    assert.strictEqual(
      scrollContainer.getAttribute("data-table-total-rows"),
      "100",
      "expected data-table-total-rows='100'",
    );

    // Initial mounted rows should be a subset of 100
    const mountedRowsAttr = Number(scrollContainer.getAttribute("data-table-mounted-rows"));
    assert.ok(mountedRowsAttr > 0 && mountedRowsAttr < 100, `expected mounted rows < 100, got ${mountedRowsAttr}`);

    // Sticky header check
    const thead = container.querySelector("thead");
    assert.ok(thead, "expected thead to exist");
    assert.strictEqual(thead.style.position, "sticky", "thead must have sticky positioning");
    assert.strictEqual(thead.style.top, "0px", "thead top must be 0");

    // Native table structure check
    assert.ok(container.querySelector("table"), "must render native table");
    assert.ok(container.querySelector("tbody"), "must render native tbody");

    // Spacer rows check: top spacer should be 0 (unrendered), bottom spacer should exist
    const bottomSpacer = container.querySelector(".markdown-table-spacer-bottom");
    assert.ok(bottomSpacer, "expected bottom spacer row for unrendered tail rows");
    assert.strictEqual(bottomSpacer.getAttribute("aria-hidden"), "true", "spacer row must have aria-hidden='true'");

    root.unmount();
    console.log("  [PASS] 5. Finalized large table: mounts windowed subset with sticky header and spacer");
  }

  // 6. End-Row Reachability & Row Data Preservation: Scroll to bottom reaches row 99 with intact data
  {
    const { window } = setupDomEnvironment();
    const container = window.document.getElementById("root");
    assert.ok(container, "root container required");
    const block = createTestTableBlock(100, true);
    const store = createRendererStore([block]);
    const registry = new ComponentRegistry({}, {}, {}, {
      tableVirtualization: {
        enabled: true,
        minRows: 25,
        estimatedRowHeight: 40,
        overscan: 5,
        maxHeight: "400px",
      },
    });

    const root = createRoot(container);
    root.render(React.createElement(BlockNodeRenderer, { store, blockId: block.id, registry }));
    await sleep(40);

    const scrollContainer = container.querySelector(".markdown-table-container") as HTMLElement | null;
    assert.ok(scrollContainer, "expected scroll container");

    // Simulate scrolling down to the bottom (100 rows * 40px = 4000px, container = 400px, scrollTop = 3600)
    scrollContainer.scrollTop = 3600;
    scrollContainer.dispatchEvent(new window.Event("scroll"));
    await sleep(40);

    // End-row reachability: Row-99 must be rendered and visible in DOM
    const lastRow = container.querySelector('tr[data-row-id="table-1::row:99"]');
    assert.ok(lastRow, "last row (Row-99) must be mounted when scrolled to bottom");
    assert.ok(lastRow.textContent?.includes("Row-99"), "Row-99 data must be preserved");
    assert.ok(lastRow.textContent?.includes("Score-9900"), "Row-99 score must be preserved");

    // Bottom spacer must be zero or gone
    const bottomSpacer = container.querySelector(".markdown-table-spacer-bottom");
    assert.strictEqual(bottomSpacer, null, "bottom spacer must be 0 / unmounted at bottom");

    // Top spacer must be present and accurate
    const topSpacer = container.querySelector(".markdown-table-spacer-top") as HTMLElement | null;
    assert.ok(topSpacer, "top spacer must exist when scrolled to bottom");
    const topSpacerHeight = Number.parseFloat(topSpacer.style.height || "0");
    assert.ok(topSpacerHeight > 2000, `expected large top spacer height, got ${topSpacerHeight}`);

    root.unmount();
    console.log("  [PASS] 6. End-row reachability: user reaches last row with full row data preserved");
  }

  // 7. Custom tableElements Preservation: Custom wrappers and tags are fully preserved
  {
    const { window } = setupDomEnvironment();
    const container = window.document.getElementById("root");
    assert.ok(container, "root container required");
    const block = createTestTableBlock(50, true);
    const store = createRendererStore([block]);

    const customTableElements: TableElements = {
      Table: ({ children, className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) =>
        React.createElement("table", { ...props, className: `custom-table-cls ${className ?? ""}`, "data-custom": "table" }, children),
      Thead: ({ children, className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) =>
        React.createElement("thead", { ...props, className: `custom-thead-cls ${className ?? ""}`, "data-custom": "thead" }, children),
      Tbody: ({ children, className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) =>
        React.createElement("tbody", { ...props, className: `custom-tbody-cls ${className ?? ""}`, "data-custom": "tbody" }, children),
      Tr: ({ children, className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) =>
        React.createElement("tr", { ...props, className: `custom-tr-cls ${className ?? ""}`, "data-custom": "tr" }, children),
      Th: ({ children, className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) =>
        React.createElement("th", { ...props, className: `custom-th-cls ${className ?? ""}`, "data-custom": "th" }, children),
      Td: ({ children, className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) =>
        React.createElement("td", { ...props, className: `custom-td-cls ${className ?? ""}`, "data-custom": "td" }, children),
    };

    const registry = new ComponentRegistry({}, {}, {}, {
      tableVirtualization: { enabled: true, minRows: 20 },
    });
    registry.setTableElements(customTableElements);

    const root = createRoot(container);
    root.render(React.createElement(BlockNodeRenderer, { store, blockId: block.id, registry }));
    await sleep(40);

    const customTable = container.querySelector('table[data-custom="table"]');
    assert.ok(customTable, "custom Table component must be preserved");
    const customThead = container.querySelector('thead[data-custom="thead"]');
    assert.ok(customThead, "custom Thead component must be preserved");
    const customTbody = container.querySelector('tbody[data-custom="tbody"]');
    assert.ok(customTbody, "custom Tbody component must be preserved");
    const customTrs = container.querySelectorAll('tr[data-custom="tr"]');
    assert.ok(customTrs.length > 0, "custom Tr components must be preserved for rows");

    root.unmount();
    console.log("  [PASS] 7. Custom tableElements: preserved without broken wrappers or bypassed elements");
  }

  // 8. Dynamic Registry Effect: Calling setTableVirtualization triggers view re-render
  {
    const { window } = setupDomEnvironment();
    const container = window.document.getElementById("root");
    assert.ok(container, "root container required");
    const block = createTestTableBlock(60, true);
    const store = createRendererStore([block]);
    const registry = new ComponentRegistry(); // Initially disabled

    const root = createRoot(container);
    root.render(React.createElement(BlockNodeRenderer, { store, blockId: block.id, registry }));
    await sleep(40);

    const initialTable = container.querySelector("table");
    assert.ok(initialTable, "expected table");
    assert.strictEqual(initialTable.getAttribute("data-table-virtualized"), "false");
    assert.strictEqual(container.querySelectorAll("tbody tr").length, 60);

    // Dynamically enable table virtualization via registry
    registry.setTableVirtualization({ enabled: true, minRows: 20, overscan: 5 });
    await sleep(40);

    const scrollContainer = container.querySelector(".markdown-table-container");
    assert.ok(scrollContainer, "expected scrollContainer to appear after registry update");
    assert.strictEqual(scrollContainer.getAttribute("data-table-virtualized"), "true");
    const mountedRows = container.querySelectorAll("tbody tr[data-row-id]");
    assert.ok(mountedRows.length < 60, "expected fewer mounted rows after virtualization enabled");

    root.unmount();
    console.log("  [PASS] 8. Dynamic registry effect: setTableVirtualization triggers view re-render");
  }

  console.log("All table virtualization tests passed successfully!");
}

runTableVirtualizationTestSuite().catch((error: unknown) => {
  console.error("Test failed:", error);
  process.exitCode = 1;
});
