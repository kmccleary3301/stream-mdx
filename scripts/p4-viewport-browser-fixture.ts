import React from "react";
import { createRoot } from "react-dom/client";
import { StreamingMarkdown, type StreamingMarkdownHandle } from "@stream-mdx/react";

const tableRowCount = 10_000;
const codeLineCount = 5_000;
const tableRows = Array.from({ length: tableRowCount }, (_, index) => `| Row-${index} | Description-${index} |`);
const codeLines = Array.from(
  { length: codeLineCount },
  (_, index) => `const codeLine${index.toString().padStart(5, "0")} = "source-${index}";`,
);
const authoredCode = `${codeLines.join("\r\n")}\r\n`;
const tableMarkdown = ["| Key | Description |", "| --- | --- |", ...tableRows].join("\n");
const codeBlock = `\`\`\`ts\r\n${authoredCode}\`\`\``;
const markdown = `${codeBlock}\n\n${tableMarkdown}\n`;
const rendererRef = React.createRef<StreamingMarkdownHandle>();
const sourceAppendChunkSize = 65_536;

async function appendSource(renderer: StreamingMarkdownHandle, source: string): Promise<void> {
  for (let offset = 0; offset < source.length;) {
    const end = Math.min(offset + sourceAppendChunkSize, source.length);
    const chunk = source.slice(offset, end);
    await renderer.waitForCapacity({ units: chunk.length });
    const result = renderer.append(chunk);
    offset = end;
    if (result.shouldPause) await renderer.waitForCapacity({ units: 0 });
  }
}

async function waitForRenderer(): Promise<StreamingMarkdownHandle> {
  let renderer = rendererRef.current;
  while (!renderer) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    renderer = rendererRef.current;
  }
  while (!renderer.getState().workerReady) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  return renderer;
}

declare global {
  interface Window {
    __P4_VIEWPORT_SMOKE__?: {
      authoredCode: string;
      codeLineCount: number;
      tableRowCount: number;
      start: () => Promise<void>;
      appendLiveTableRow: () => Promise<void>;
    };
  }
}

window.__P4_VIEWPORT_SMOKE__ = {
  authoredCode,
  codeLineCount,
  tableRowCount,
  start: async () => {
    const renderer = await waitForRenderer();
    await appendSource(renderer, markdown);
  },
  appendLiveTableRow: async () => {
    const renderer = rendererRef.current;
    if (!renderer) throw new Error("the public renderer handle is unavailable");
    await appendSource(
      renderer,
      "| Live-append-row | A wide live row verifies the measured table columns remain fixed after growth |\n",
    );
  },
};
const container = document.getElementById("root");
if (!container) throw new Error("missing public React root");

const root = createRoot(container);
root.render(
  React.createElement(StreamingMarkdown, {
    ref: rendererRef,
    engine: "main",
    features: { tables: true, html: false, mdx: false, math: false },
    tableVirtualization: { minRows: 40, estimatedRowHeight: 40, overscan: 2, maxHeight: 240 },
    codeVirtualization: { enabled: true, windowSize: 20, bufferSize: 8, virtualizeThreshold: 100 },
    controls: { code: { copy: true, download: true } },
    caret: false,
  }),
);
