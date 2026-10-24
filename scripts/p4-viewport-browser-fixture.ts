import React from "react";
import { createRoot } from "react-dom/client";
import { StreamingMarkdown } from "@stream-mdx/react";

const tableRowCount = 10_000;
const codeLineCount = 5_000;
const tableRows = Array.from({ length: tableRowCount }, (_, index) => `| Row-${index} | Description-${index} |`);
const codeLines = Array.from(
  { length: codeLineCount },
  (_, index) => `const codeLine${index.toString().padStart(5, "0")} = "source-${index}";`,
);
const authoredCode = `${codeLines.join("\r\n")}\r\n`;
const markdown = ["| Key | Description |", "| --- | --- |", ...tableRows].join("\n") + `\n\n\`\`\`ts\r\n${authoredCode}\`\`\``;

declare global {
  interface Window {
    __P4_VIEWPORT_SMOKE__?: {
      authoredCode: string;
      codeLineCount: number;
      tableRowCount: number;
    };
  }
}

window.__P4_VIEWPORT_SMOKE__ = { authoredCode, codeLineCount, tableRowCount };
const container = document.getElementById("root");
if (!container) throw new Error("missing public React root");

createRoot(container).render(
  React.createElement(StreamingMarkdown, {
    text: markdown,
    engine: "main",
    features: { tables: true, html: false, mdx: false, math: false },
    tableVirtualization: { minRows: 40, estimatedRowHeight: 40, overscan: 2, maxHeight: 240 },
    codeVirtualization: { enabled: true, windowSize: 20, bufferSize: 8, virtualizeThreshold: 100 },
    controls: { code: { copy: true, download: true } },
    caret: false,
  }),
);
