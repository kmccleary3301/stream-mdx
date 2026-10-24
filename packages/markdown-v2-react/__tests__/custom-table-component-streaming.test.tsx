import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { StreamingMarkdown, type NodeViewProps, type StreamingMarkdownHandle } from "../src/index";
import { installTrustedNativeTestDom, waitFor, workerFactory } from "./trusted-native-fixture";

const HEADER_AND_FIRST_ROW = "# Funds\n\n| Fund | Margin |\n| --- | ---: |\n| Bridgewater | 25% |\n| Ren";
const REST = "aissance | 31% |\n| Citadel | 18% |\n";
const TABLE_SOURCE = HEADER_AND_FIRST_ROW.slice(HEADER_AND_FIRST_ROW.indexOf("| Fund")) + REST.slice(0, -1);
let presentedTableActions: NodeViewProps["actions"] | undefined;

function CustomTable({ children, metadata, actions }: NodeViewProps) {
  presentedTableActions = actions;
  return (
    <section data-custom-table="true" data-align={(metadata.align ?? []).join(",")}>
      {children}
    </section>
  );
}

function readTable(container: HTMLElement) {
  const wrapper = container.querySelector<HTMLElement>("section[data-custom-table]");
  const table = wrapper?.querySelector("table");
  return {
    header: Array.from(table?.querySelectorAll("th") ?? [], (cell) => cell.textContent),
    rows: Array.from(table?.querySelectorAll("tbody tr") ?? [], (row) => Array.from(row.querySelectorAll("td"), (cell) => cell.textContent)),
    align: wrapper?.getAttribute("data-align"),
  };
}


async function customTableComponentReceivesStreamedTable(): Promise<void> {
  const restore = installTrustedNativeTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const handle = React.createRef<StreamingMarkdownHandle>();
  const clipboardWrites: string[] = [];
  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { clipboardWrites.push(text); } },
  });
  try {
    await act(async () => {
      root.render(
        <StreamingMarkdown
          ref={handle}
          worker={() => workerFactory()}
          contentPolicy="markdown"
          features={{ tables: true }}
          caret={false}
          components={{ table: { wrapper: CustomTable } }}
        />,
      );
    });
    await waitFor(() => handle.current?.getState().workerReady === true, "worker ready");

    await act(async () => {
      handle.current?.append(HEADER_AND_FIRST_ROW);
    });
    await waitFor(() => readTable(container).rows.length >= 1, "streamed table reaches the custom component");
    const streaming = readTable(container);
    assert.deepEqual(streaming.header, ["Fund", "Margin"], "custom table receives the header while streaming");
    assert.deepEqual(streaming.rows[0], ["Bridgewater", "25%"], "custom table receives completed rows while streaming");

    await act(async () => {
      handle.current?.append(REST);
      await handle.current?.finalize();
    });
    await waitFor(() => readTable(container).rows.length === 3, "custom table receives appended rows");
    assert.deepEqual(readTable(container), {
      header: ["Fund", "Margin"],
      rows: [
        ["Bridgewater", "25%"],
        ["Renaissance", "31%"],
        ["Citadel", "18%"],
      ],
      align: ",right",
    });
    assert.ok(presentedTableActions, "the table wrapper receives source-bound actions");
    let copySucceeded = false;
    await act(async () => { copySucceeded = await presentedTableActions!.copy(); });
    assert.equal(copySucceeded, true);
    assert.deepEqual(clipboardWrites, [TABLE_SOURCE], "table copy reads its owned Markdown range with internal newlines intact");
  } finally {
    if (previousClipboard) Object.defineProperty(navigator, "clipboard", previousClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
    await act(async () => root.unmount());
    restore();
  }
}

await customTableComponentReceivesStreamedTable();
console.log("custom-table-component-streaming test passed");
process.exit(0);
