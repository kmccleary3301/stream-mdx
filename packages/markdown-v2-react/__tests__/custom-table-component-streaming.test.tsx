import assert from "node:assert/strict";
import type { InlineNode } from "@stream-mdx/core";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { StreamingMarkdown, type StreamingMarkdownHandle } from "../src/index";
import { installTrustedNativeTestDom, waitFor, workerFactory } from "./trusted-native-fixture";

const HEADER_AND_FIRST_ROW = "# Funds\n\n| Fund | Margin |\n| --- | ---: |\n| Bridgewater | 25% |\n| Ren";
const REST = "aissance | 31% |\n| Citadel | 18% |\n";

function cellText(cell: InlineNode[]): string {
  return cell.map((node) => ("text" in node && typeof node.text === "string" ? node.text : "")).join("");
}

function CustomTable({ header, rows, align }: { header?: InlineNode[][]; rows: InlineNode[][][]; align?: Array<string | null> }) {
  return (
    <table data-custom-table="true" data-align={(align ?? []).join(",")}>
      <thead>
        <tr>{(header ?? []).map((cell, index) => <th key={index}>{cellText(cell)}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>{row.map((cell, index) => <td key={index}>{cellText(cell)}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

function readTable(container: HTMLElement) {
  const table = container.querySelector("table[data-custom-table]");
  return {
    header: Array.from(table?.querySelectorAll("th") ?? [], (cell) => cell.textContent),
    rows: Array.from(table?.querySelectorAll("tbody tr") ?? [], (row) => Array.from(row.querySelectorAll("td"), (cell) => cell.textContent)),
    align: table?.getAttribute("data-align"),
  };
}

async function customTableComponentReceivesStreamedTable(): Promise<void> {
  const restore = installTrustedNativeTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const handle = React.createRef<StreamingMarkdownHandle>();
  try {
    await act(async () => {
      root.render(
        <StreamingMarkdown
          ref={handle}
          worker={() => workerFactory()}
          contentPolicy="markdown"
          features={{ tables: true }}
          caret={false}
          components={{ table: CustomTable as never }}
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
  } finally {
    await act(async () => root.unmount());
    restore();
  }
}

await customTableComponentReceivesStreamedTable();
console.log("custom-table-component-streaming test passed");
process.exit(0);
