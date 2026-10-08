import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

import type { DocumentSnapshot } from "@stream-mdx/core";
import { applyPatchBatch, createInitialSnapshot } from "@stream-mdx/core";
import { ComponentRegistry, MarkdownBlocksRenderer } from "@stream-mdx/react/server";
import { compileMarkdownSnapshotDirect } from "@stream-mdx/worker/direct";
import { createWorkerThread } from "@stream-mdx/worker/node";

import { normalizeHtmlSemantics } from "../../tests/conformance/normalizer.mts";

type SpecExample = {
  markdown: string;
  html: string;
  section: string;
  number: number;
};

type ConformanceExample = {
  id: string;
  section: string;
  number: number;
  markdown: string;
  expectedHtml: string;
};

type SectionStats = {
  total: number;
  streamMdxStatic: number;
  streamMdxStreaming: number;
  micromark: number;
  streamdown: number;
  streamingDivergences: number;
};

type ExampleResult = {
  id: string;
  section: string;
  number: number;
  markdown: string;
  specHtml: string;
  oracleNormalized: string;
  streamMdxStaticNormalized: string;
  streamdownNormalized: string;
  streamMdxStaticPass: boolean;
  streamMdxStreamingPass: boolean;
  micromarkPass: boolean;
  streamdownPass: boolean;
  streamingDiverged: boolean;
  streamingChunkMatches?: Record<number, boolean>;
};

type BaselineFile = {
  version: number;
  updatedAt: string;
  counts: {
    total: number;
    streamMdxStatic: number;
    streamMdxStreaming: number;
    micromark: number;
    streamdown: number;
  };
  passingIds: string[];
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASELINE_PATH = path.join(ROOT, "tests/conformance/baseline.json");
const REPORT_PATH = path.join(ROOT, "tmp/conformance/report.json");

// Suppress noisy Shiki warning logs during bulk conformance run
const originalWarn = console.warn;
const originalError = console.error;
function silenceConsole(): void {
  console.warn = (...args: unknown[]) => {
    const msg = String(args[0] ?? "");
    if (msg.includes("[Shiki]") || msg.includes("Failed to load language")) return;
    originalWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    const msg = String(args[0] ?? "");
    if (msg.includes("useLayoutEffect does nothing on the server") || msg.includes("Language `")) return;
    originalError(...args);
  };
}

function restoreConsole(): void {
  console.warn = originalWarn;
  console.error = originalError;
}

async function loadExamples(): Promise<ConformanceExample[]> {
  const cmPath = path.join(ROOT, "tests/conformance/fixtures/commonmark-spec-0.31.2.json");
  const gfmPath = path.join(ROOT, "tests/conformance/fixtures/gfm-spec-extensions.json");

  const cmRaw = await fs.readFile(cmPath, "utf8");
  const gfmRaw = await fs.readFile(gfmPath, "utf8");

  // spec.txt renders tabs as "→"; restore real tabs in both input and expected output.
  const untab = (t: SpecExample): SpecExample => ({ ...t, markdown: t.markdown.replace(/→/g, "\t"), html: t.html.replace(/→/g, "\t") });
  const cmTests = (JSON.parse(cmRaw) as SpecExample[]).map(untab);
  const gfmTests = (JSON.parse(gfmRaw) as SpecExample[]).map(untab);

  const list: ConformanceExample[] = [];
  for (const t of cmTests) {
    list.push({
      id: `cm_${t.number}`,
      section: t.section,
      number: t.number,
      markdown: t.markdown,
      expectedHtml: t.html,
    });
  }
  for (const t of gfmTests) {
    list.push({
      id: `gfm_${t.number}`,
      section: t.section,
      number: t.number,
      markdown: t.markdown,
      expectedHtml: t.html,
    });
  }
  return list;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const updateBaseline = args.includes("--update-baseline");
  const checkBaseline = args.includes("--check");
  silenceConsole();
  const { Streamdown } = (await import("streamdown")) as {
    Streamdown: React.ComponentType<{ mode: string; children?: React.ReactNode }>;
  };
  const examples = await loadExamples();
  const initConfig = {
    docPlugins: { html: true, tables: true, footnotes: true, math: true, callouts: true, mdx: false },
    mdx: { compileMode: "server" as const },
    prewarmLangs: [],
  };

  const streamingWorker = createWorkerThread();
  let workerSnapshot: DocumentSnapshot | null = null;
  let workerFinalizedResolver: (() => void) | null = null;

  streamingWorker.on("message", (msg) => {
    if (msg.type === "INITIALIZED") {
      workerSnapshot = createInitialSnapshot(msg.blocks);
    } else if (msg.type === "PATCH" && workerSnapshot) {
      workerSnapshot.blocks = applyPatchBatch(workerSnapshot, msg.patches);
    } else if (msg.type === "FINALIZED") {
      if (workerFinalizedResolver) workerFinalizedResolver();
    }
  });

  async function runStreaming(text: string, chunkSize: number) {
    workerSnapshot = null;
    const finalizedPromise = new Promise<void>((r) => {
      workerFinalizedResolver = r;
    });
    streamingWorker.postMessage({ type: "INIT", initialContent: "", ...initConfig });
    for (let i = 0; i < text.length; i += chunkSize) {
      streamingWorker.postMessage({ type: "APPEND", text: text.slice(i, i + chunkSize) });
    }
    streamingWorker.postMessage({ type: "FINALIZE" });
    await finalizedPromise;
    workerFinalizedResolver = null;

    const registry = new ComponentRegistry();
    const markup = renderToStaticMarkup(
      React.createElement(MarkdownBlocksRenderer, {
        blocks: workerSnapshot ? workerSnapshot.blocks : [],
        componentRegistry: registry,
      }),
    );
    return normalizeHtmlSemantics(markup);
  }

  const results: ExampleResult[] = [];
  const sectionOrder: string[] = [];
  const sectionStats: Record<string, SectionStats> = {};

  for (const ex of examples) {
    if (!sectionStats[ex.section]) {
      sectionOrder.push(ex.section);
      sectionStats[ex.section] = {
        total: 0,
        streamMdxStatic: 0,
        streamMdxStreaming: 0,
        micromark: 0,
        streamdown: 0,
        streamingDivergences: 0,
      };
    }
    const stats = sectionStats[ex.section];
    stats.total++;

    // Ground truth: the spec's expected HTML. micromark is a sanity column for the normalizer.
    const specNormalized = normalizeHtmlSemantics(ex.expectedHtml);
    const oracleRaw = micromark(ex.markdown, {
      extensions: [gfm()],
      htmlExtensions: [gfmHtml()],
      allowDangerousHtml: true,
    });
    const oracleNormalized = specNormalized;
    const micromarkPass = normalizeHtmlSemantics(oracleRaw) === specNormalized;
    if (micromarkPass) stats.micromark++;

    // 2. StreamMDX Static
    const staticCompiled = await compileMarkdownSnapshotDirect({
      text: ex.markdown,
      init: initConfig,
    });
    const staticRegistry = new ComponentRegistry();
    const staticMarkup = renderToStaticMarkup(
      React.createElement(MarkdownBlocksRenderer, {
        blocks: staticCompiled.blocks,
        componentRegistry: staticRegistry,
      }),
    );
    const streamMdxStaticNormalized = normalizeHtmlSemantics(staticMarkup);
    const streamMdxStaticPass = streamMdxStaticNormalized === oracleNormalized;
    if (streamMdxStaticPass) stats.streamMdxStatic++;

    // 3. StreamMDX Streaming (chunks: 1, 7, 64)
    let streamingMatchesStatic = true;
    const chunkMatches: Record<number, boolean> = {};
    for (const size of [1, 7, 64]) {
      const streamingNorm = await runStreaming(ex.markdown, size);
      const matches = streamingNorm === streamMdxStaticNormalized;
      chunkMatches[size] = matches;
      if (!matches) {
        streamingMatchesStatic = false;
      }
    }

    const streamingDiverged = !streamingMatchesStatic;
    if (streamingDiverged) stats.streamingDivergences++;
    const streamMdxStreamingPass = streamingMatchesStatic && streamMdxStaticPass;
    if (streamMdxStreamingPass) stats.streamMdxStreaming++;

    // 4. Streamdown 2.7.0
    let streamdownNormalized = "";
    let streamdownPass = false;
    try {
      // linkSafety off: its default renders links as <button> (a UI choice, not a parse result).
      const sdownMarkup = renderToStaticMarkup(
        React.createElement(Streamdown, { mode: "static", linkSafety: { enabled: false } }, ex.markdown),
      );
      streamdownNormalized = normalizeHtmlSemantics(sdownMarkup);
      streamdownPass = streamdownNormalized === oracleNormalized;
      if (streamdownPass) stats.streamdown++;
    } catch (error) {
      streamdownNormalized = `RENDER_ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }

    results.push({
      id: ex.id,
      section: ex.section,
      number: ex.number,
      markdown: ex.markdown,
      specHtml: ex.expectedHtml,
      oracleNormalized,
      streamMdxStaticNormalized,
      streamdownNormalized,
      streamMdxStaticPass,
      streamMdxStreamingPass,
      micromarkPass,
      streamdownPass,
      streamingDiverged,
      streamingChunkMatches: chunkMatches,
    });
  }

  streamingWorker.terminate();
  restoreConsole();

  // Print summary table
  const colSecWidth = 34;
  const colNumWidth = 8;
  const pad = (str: string, len: number) => str.padEnd(len);
  const padNum = (num: number, len: number) => String(num).padStart(len);

  console.log("\nCommonMark & GFM Extension Conformance Report");
  console.log("=".repeat(88));
  console.log(
    `${pad("Section", colSecWidth)} | ${padNum("Total", colNumWidth)} | ${padNum("StreamMDX", colNumWidth)} | ${padNum("Streaming", colNumWidth)} | ${padNum("micromark", colNumWidth)} | ${padNum("Streamdown", colNumWidth)}`,
  );
  console.log("-".repeat(88));

  let totCount = 0;
  let totStatic = 0;
  let totStreaming = 0;
  let totMicromark = 0;
  let totStreamdown = 0;
  let totDivergences = 0;

  for (const sec of sectionOrder) {
    const s = sectionStats[sec];
    totCount += s.total;
    totStatic += s.streamMdxStatic;
    totStreaming += s.streamMdxStreaming;
    totMicromark += s.micromark;
    totStreamdown += s.streamdown;
    totDivergences += s.streamingDivergences;

    const secName = sec.length > colSecWidth ? `${sec.slice(0, colSecWidth - 1)}…` : sec;
    console.log(
      `${pad(secName, colSecWidth)} | ${padNum(s.total, colNumWidth)} | ${padNum(s.streamMdxStatic, colNumWidth)} | ${padNum(s.streamMdxStreaming, colNumWidth)} | ${padNum(s.micromark, colNumWidth)} | ${padNum(s.streamdown, colNumWidth)}`,
    );
  }

  console.log("=".repeat(88));
  console.log(
    `${pad("TOTAL", colSecWidth)} | ${padNum(totCount, colNumWidth)} | ${padNum(totStatic, colNumWidth)} | ${padNum(totStreaming, colNumWidth)} | ${padNum(totMicromark, colNumWidth)} | ${padNum(totStreamdown, colNumWidth)}`,
  );
  console.log(`Streaming divergences from static: ${totDivergences}`);

  // Write full JSON report to tmp/conformance/report.json
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  const reportPayload = {
    generatedAt: new Date().toISOString(),
    totals: {
      total: totCount,
      streamMdxStatic: totStatic,
      streamMdxStreaming: totStreaming,
      micromark: totMicromark,
      streamdown: totStreamdown,
      streamingDivergences: totDivergences,
    },
    sectionStats,
    results,
  };
  await fs.writeFile(REPORT_PATH, JSON.stringify(reportPayload, null, 2));
  console.log(`Wrote full report to ${REPORT_PATH}`);

  // Handle baseline update or check
  const passingIds = results.filter((r) => r.streamMdxStaticPass && r.streamMdxStreamingPass).map((r) => r.id);

  if (updateBaseline) {
    const baselinePayload: BaselineFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      counts: {
        total: totCount,
        streamMdxStatic: totStatic,
        streamMdxStreaming: totStreaming,
        micromark: totMicromark,
        streamdown: totStreamdown,
      },
      passingIds,
    };
    await fs.writeFile(BASELINE_PATH, JSON.stringify(baselinePayload, null, 2));
    console.log(`Baseline updated at ${BASELINE_PATH} (${passingIds.length} passing IDs).`);
  } else if (checkBaseline) {
    try {
      const rawBaseline = await fs.readFile(BASELINE_PATH, "utf8");
      const baseline = JSON.parse(rawBaseline) as { passingIds: string[] };
      const currentPassing = new Set(passingIds);
      const regressions = baseline.passingIds.filter((id) => !currentPassing.has(id));

      if (regressions.length > 0) {
        console.error(`\n[FAIL] Conformance regression detected! ${regressions.length} baseline test(s) failed:`);
        for (const reg of regressions.slice(0, 10)) {
          console.error(`  - ${reg}`);
        }
        if (regressions.length > 10) {
          console.error(`  ... and ${regressions.length - 10} more`);
        }
        process.exit(1);
      } else {
        console.log(`\n[PASS] Conformance ratchet check passed. All ${baseline.passingIds.length} baseline tests passed.`);
      }
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        console.warn(`Baseline file not found at ${BASELINE_PATH}. Run with --update-baseline first.`);
      } else {
        throw err;
      }
    }
  }
}

main().catch((err: unknown) => {
  restoreConsole();
  if (err instanceof Error && err.stack) {
    process.stderr.write("STACK:\n" + err.stack + "\n");
  } else {
    process.stderr.write("ERR: " + String(err) + "\n");
  }
  process.exit(1);
});
