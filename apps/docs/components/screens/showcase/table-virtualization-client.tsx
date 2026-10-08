"use client";

import { useMemo, useRef, useState } from "react";
import { StreamingMarkdown } from "@stream-mdx/react";
import type { TableVirtualizationOptions } from "@stream-mdx/react";
import { createDemoTableElements } from "@/lib/streaming-demo-registry";

function generateTableMarkdown(rowCount: number): string {
  const lines: string[] = [];
  lines.push("# Large Dataset: Table Row Virtualization");
  lines.push("");
  lines.push(
    "This table uses **sticky headers**, **measured variable-height rows**, and **multiline cells**. Scroll to the last row to inspect the final record.",
  );
  lines.push("");
  lines.push("| ID | Metric Name | Status | Detailed Description | Latency (p95) | Memory |");
  lines.push("| :--- | :--- | :---: | :--- | ---: | ---: |");

  for (let i = 0; i < rowCount; i++) {
    const status = i % 7 === 0 ? "⚠️ Warning" : i % 13 === 0 ? "❌ Critical" : "✅ Normal";
    let desc = `Metric telemetry stream for partition ${i}.`;
    if (i % 5 === 0) {
      desc = `Primary partition ${i} processing batch events.<br>Second multiline observation report.<br>Third line telemetry notes.`;
    } else if (i % 11 === 0) {
      desc = `High-throughput ingestion cluster.<br>Buffer occupancy stable at 92%.`;
    }
    const latency = `${(1.2 + (i % 20) * 0.4).toFixed(1)} ms`;
    const memory = `${(48 + (i % 64) * 2)} MB`;
    lines.push(`| PK-${String(i).padStart(4, "0")} | stream.metric.${i} | ${status} | ${desc} | ${latency} | ${memory} |`);
  }

  return lines.join("\n");
}

export function TableVirtualizationClient() {
  const [rowCount, setRowCount] = useState(250);
  const [virtualizationEnabled, setVirtualizationEnabled] = useState(true);
  const [maxHeight, setMaxHeight] = useState("500px");
  const [overscan, setOverscan] = useState(8);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const markdown = useMemo(() => generateTableMarkdown(rowCount), [rowCount]);
  const tableElements = useMemo(() => createDemoTableElements(), []);

  const virtualizationConfig: TableVirtualizationOptions = useMemo(() => {
    return {
      enabled: virtualizationEnabled,
      minRows: 25,
      estimatedRowHeight: 44,
      overscan,
      maxHeight,
    };
  }, [virtualizationEnabled, overscan, maxHeight]);

  const handleScrollToBottom = () => {
    const tableContainer = containerRef.current?.querySelector<HTMLDivElement>(".markdown-table-container");
    if (tableContainer) {
      tableContainer.scrollTop = tableContainer.scrollHeight;
    }
  };

  const handleScrollToTop = () => {
    const tableContainer = containerRef.current?.querySelector<HTMLDivElement>(".markdown-table-container");
    if (tableContainer) {
      tableContainer.scrollTop = 0;
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8">
      <header className="route-panel-hero flex flex-col gap-3 px-6 py-6 md:px-8">
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">
            Executable Showcase
          </span>
          <span className="text-xs text-muted-foreground">apps/docs/app/showcase/table-virtualization</span>
        </div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Table Row Virtualization</h1>
        <p className="max-w-3xl text-sm text-muted">
          Only the visible rows and a bounded buffer mount after the table finalizes. The table uses native elements.
          Every fifth description has three lines. The last record is <code>PK-{String(rowCount - 1).padStart(4, "0")}</code>.
        </p>
      </header>

      {/* Interactive Controls */}
      <section className="route-panel flex flex-wrap items-center justify-between gap-4 p-4 text-xs">
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer font-medium">
            <input
              type="checkbox"
              checked={virtualizationEnabled}
              onChange={(e) => setVirtualizationEnabled(e.target.checked)}
              className="rounded border-border text-primary focus:ring-primary"
            />
            <span>Virtualization Enabled</span>
          </label>

          <label className="flex items-center gap-2">
            <span className="text-muted">Row Count:</span>
            <select
              value={rowCount}
              onChange={(e) => setRowCount(Number(e.target.value))}
              className="rounded border border-border bg-background px-2 py-1 text-xs"
            >
              <option value="50">50 rows</option>
              <option value="150">150 rows</option>
              <option value="250">250 rows</option>
              <option value="500">500 rows</option>
            </select>
          </label>

          <label className="flex items-center gap-2">
            <span className="text-muted">Max Height:</span>
            <select
              value={maxHeight}
              onChange={(e) => setMaxHeight(e.target.value)}
              className="rounded border border-border bg-background px-2 py-1 text-xs"
            >
              <option value="350px">350px</option>
              <option value="500px">500px</option>
              <option value="650px">650px</option>
            </select>
          </label>

          <label className="flex items-center gap-2">
            <span className="text-muted">Overscan:</span>
            <input
              type="number"
              min="2"
              max="30"
              value={overscan}
              onChange={(e) => setOverscan(Math.max(1, Number(e.target.value) || 8))}
              className="w-16 rounded border border-border bg-background px-2 py-1 text-xs"
            />
          </label>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleScrollToTop}
            className="rounded border border-border bg-background/60 px-3 py-1 text-xs font-medium hover:bg-background"
          >
            Scroll to Top
          </button>
          <button
            type="button"
            id="scroll-to-bottom-button"
            onClick={handleScrollToBottom}
            className="rounded border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/20"
          >
            Scroll to Last Row
          </button>
        </div>
      </section>

      {/* Render Area */}
      <main ref={containerRef} className="route-panel overflow-hidden p-6" id="table-showcase-render-container">
        <StreamingMarkdown
          text={markdown}
          features={{ tables: true, html: true }}
          tableVirtualization={virtualizationConfig}
          tableElements={tableElements}
        />
      </main>
    </div>
  );
}
