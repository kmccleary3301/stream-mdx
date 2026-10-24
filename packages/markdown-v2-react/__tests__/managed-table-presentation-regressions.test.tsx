import assert from "node:assert/strict";
import { StreamingMarkdown, type NodePresentations, type NodeViewActions, type StreamingMarkdownHandle } from "@stream-mdx/react";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { installTrustedNativeTestDom, waitFor, workerFactory } from "./trusted-native-fixture";

const HEADER = "| ID | Description |\n| --- | --- |\n";
const tableRows = (from: number, to: number, label = "Row"): string => Array.from(
  { length: to - from },
  (_, offset) => `| ${label}-${from + offset} | Description-${from + offset} |`,
).join("\n") + "\n";

async function filteredManagedTablesRenderNoShellOrControls(): Promise<void> {
  const restore = installTrustedNativeTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const stream = React.createRef<StreamingMarkdownHandle>();
  let wrapperCalls = 0;
  try {
    await act(async () => {
      root.render(
        <StreamingMarkdown
          ref={stream}
          worker={() => workerFactory()}
          contentPolicy="markdown"
          features={{ tables: true }}
          controls={{ table: true }}
          disallowedElements={["table"]}
          caret={false}
          components={{
            table: {
              wrapper: ({ children }) => {
                wrapperCalls += 1;
                return <>{children}</>;
              },
            },
          }}
        />,
      );
    });
    await waitFor(() => stream.current?.getState().workerReady === true, "filtered table worker is ready");
    await act(async () => {
      stream.current?.append(HEADER + tableRows(0, 2));
      await stream.current?.finalize();
    });
    await waitFor(() => stream.current?.getState().blocks.some((block) => block.type === "table") === true,
      "the public stream owns the filtered table block");

    assert.equal(wrapperCalls, 0, "a filtered managed table does not invoke its presentation wrapper");
    assert.equal(container.querySelector("table"), null, "a disallowed managed table has no native table");
    assert.equal(container.querySelector(".stream-mdx-table-wrapper"), null, "a filtered managed table emits no control shell");
    assert.equal(container.querySelector('[aria-label="Scrollable table"]'), null, "a filtered managed table emits no viewport shell");
    assert.equal(container.querySelector("button[data-stream-mdx-action]"), null, "a filtered managed table emits no controls");
  } finally {
    root.unmount();
    restore();
  }
}
function decorateNativeChild(children: React.ReactNode, attribute: string): React.ReactElement {
  assert.ok(React.isValidElement(children), "table-part wrappers receive their prepared native element");
  return React.cloneElement(children as React.ReactElement, { [attribute]: "true" });
}

async function nativeTablePartPresentationsRetainTableNesting(): Promise<void> {
  const restore = installTrustedNativeTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const stream = React.createRef<StreamingMarkdownHandle>();
  const presentations = {
    "table-row": {
      props: { "data-row-presentation": "props" },
      wrapper: ({ children }) => decorateNativeChild(children, "data-row-wrapper"),
    },
    "table-cell": {
      props: { "data-cell-presentation": "props" },
      wrapper: ({ children }) => decorateNativeChild(children, "data-cell-wrapper"),
    },
  } satisfies NodePresentations;
  try {
    await act(async () => {
      root.render(
        <StreamingMarkdown
          ref={stream}
          worker={() => workerFactory()}
          contentPolicy="markdown"
          features={{ tables: true }}
          tableVirtualization={false}
          caret={false}
          components={presentations}
        />,
      );
    });
    await waitFor(() => stream.current?.getState().workerReady === true, "presented table worker is ready");
    await act(async () => {
      stream.current?.append(HEADER + tableRows(0, 2));
      await stream.current?.finalize();
    });
    await waitFor(() => container.querySelector("table") !== null, "native table renders with table-part presentations");

    const nativeRows = Array.from(container.querySelectorAll<HTMLTableRowElement>("table tr"));
    assert.equal(nativeRows.length, 3, "the table retains its native header and body rows");
    for (const row of nativeRows) {
      assert.ok(row.parentElement?.tagName === "THEAD" || row.parentElement?.tagName === "TBODY",
        "presented rows remain direct children of a native table section");
      assert.equal(row.dataset.rowPresentation, "props");
      assert.equal(row.dataset.rowWrapper, "true");
      for (const cell of Array.from(row.querySelectorAll<HTMLTableCellElement>("th, td"))) {
        assert.equal(cell.parentElement, row, "presented cells remain direct children of their native row");
        assert.equal(cell.dataset.cellPresentation, "props");
        assert.equal(cell.dataset.cellWrapper, "true");
      }
    }
  } finally {
    root.unmount();
    restore();
  }
}

async function savedTableActionsRejectAfterResetWithReusedNodeIds(): Promise<void> {
  const restore = installTrustedNativeTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const stream = React.createRef<StreamingMarkdownHandle>();
  const tableActions: Array<{ id: string; copy: NodeViewActions["copy"] }> = [];
  const presentations = {
    table: {
      wrapper: ({ children, metadata, actions }) => {
        if (metadata.type === "table") tableActions.push({ id: metadata.id, copy: actions.copy });
        return <>{children}</>;
      },
    },
  } satisfies NodePresentations;
  const copied: string[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  try {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => { copied.push(value); } },
    });
    await act(async () => {
      root.render(
        <StreamingMarkdown
          ref={stream}
          worker={() => workerFactory()}
          contentPolicy="markdown"
          features={{ tables: true }}
          tableVirtualization={false}
          caret={false}
          components={presentations}
        />,
      );
    });
    await waitFor(() => stream.current?.getState().workerReady === true, "table action worker is ready");
    await act(async () => {
      stream.current?.append(HEADER + tableRows(0, 2));
      await stream.current?.finalize();
    });
    await waitFor(() => tableActions.length > 0, "the initial table wrapper receives its source-bound action");

    const initialTableAction = tableActions[0];
    assert.ok(initialTableAction);
    const nextSource = HEADER + tableRows(0, 1, "Replacement");
    await act(async () => {
      stream.current?.restart();
    });
    await waitFor(
      () => stream.current?.getState().workerReady === true && stream.current.getState().blocks.length === 0,
      "restart installs a fresh document generation",
    );
    await act(async () => {
      stream.current?.append(nextSource);
      await stream.current?.finalize();
    });
    await waitFor(() => tableActions.length > 1, "replacement table wrapper is presented");
    assert.equal(tableActions.at(-1)?.id, initialTableAction.id, "reset reuses the table node ID");
    await assert.rejects(initialTableAction.copy(), /replaced or disposed owner/,
      "a saved wrapper action rejects after its store generation is reset");
    assert.deepEqual(copied, [], "a stale wrapper action cannot copy replacement document source");
  } finally {
    root.unmount();
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
    restore();
  }
}

try {
  await filteredManagedTablesRenderNoShellOrControls();
  await nativeTablePartPresentationsRetainTableNesting();
  await savedTableActionsRejectAfterResetWithReusedNodeIds();
  console.log("managed table presentation regressions passed");
} catch (error) {
  console.error(error);
  process.exit(1);
}

process.exit(0);
