import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

import { ComponentRegistry, MarkdownBlocksRenderer, createRendererStore, type RendererStore } from "@stream-mdx/react/server";
import { compileMarkdownSnapshotDirect } from "@stream-mdx/worker/direct";
import { createWorkerThread } from "@stream-mdx/worker/node";

import { normalizeHtmlSemantics, type NormalizerOptions } from "../../tests/conformance/normalizer.mts";
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

type EngineStats = {
  total: number;
  streamMdxStatic: number;
  streamMdxSsr: number;
  streamMdxStreaming: number;
  micromark: number;
  streamdown: number;
  streamdownRaw: number;
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
  streamMdxSsrNormalized: string;
  streamdownNormalized: string;
  streamdownRawNormalized: string;
  streamMdxStaticPass: boolean;
  streamMdxSsrPass: boolean;
  streamMdxStreamingPass: boolean;
  micromarkPass: boolean;
  streamdownPass: boolean;
  streamdownRawPass: boolean;
  streamingDiverged: boolean;
  streamingChunkMatches?: Record<number, boolean>;
  strictOracleNormalized: string;
  strictStreamMdxStaticNormalized: string;
  strictStreamMdxSsrNormalized: string;
  strictStreamdownNormalized: string;
  strictStreamdownRawNormalized: string;
  strictStreamMdxStaticPass: boolean;
  strictStreamMdxSsrPass: boolean;
  strictStreamMdxStreamingPass: boolean;
  strictMicromarkPass: boolean;
  strictStreamdownPass: boolean;
  strictStreamdownRawPass: boolean;
  strictStreamingDiverged: boolean;
};

type BaselineFile = {
  version: number;
  updatedAt: string;
  counts: {
    total: number;
    streamMdxStatic: number;
    streamMdxSsr: number;
    streamMdxStreaming: number;
    micromark: number;
    streamdown: number;
    streamdownRaw?: number;
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

/**
 * CommonMark examples whose expected output the GFM autolink-literal extension changes.
 * StreamMDX targets GFM, so these are scored against the GFM result (GFM spec §6.9).
 */
const GFM_EXPECTED_OVERRIDES: Record<string, string> = {
  cm_602: '<p>&lt;<a href="https://foo.bar/baz">https://foo.bar/baz</a> bim&gt;</p>',
  cm_608: '<p>&lt; <a href="https://foo.bar">https://foo.bar</a> &gt;</p>',
  cm_611: '<p><a href="https://example.com">https://example.com</a></p>',
  cm_612: '<p><a href="mailto:foo@bar.example.com">foo@bar.example.com</a></p>',
};

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
      expectedHtml: GFM_EXPECTED_OVERRIDES[`cm_${t.number}`] ?? t.html,
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
  const { Streamdown, defaultRehypePlugins } = (await import("streamdown")) as {
    Streamdown: React.ComponentType<{
      mode: string;
      linkSafety?: { enabled: boolean };
      rehypePlugins?: unknown[];
      children?: React.ReactNode;
    }>;
    defaultRehypePlugins: { raw: unknown; sanitize: unknown; harden: unknown };
  };
  // The client path runs in a browser: DOMPurify sanitization and HTML-to-React mapping need DOM globals.
  // Installed after the Streamdown import so its react-dom client entry is not selected at load.
  const { window: domWindow } = new JSDOM("");
  Object.assign(globalThis, {
    window: domWindow,
    document: domWindow.document,
    DOMParser: domWindow.DOMParser,
    Node: domWindow.Node,
    Element: domWindow.Element,
    HTMLElement: domWindow.HTMLElement,
  });
  const examples = await loadExamples();
  const initConfig = {
    docPlugins: { html: true, tables: true, footnotes: true, math: true, callouts: true, mdx: false },
    mdx: { compileMode: "server" as const },
    prewarmLangs: [],
  };

  /** Production client path: StreamingMarkdown renders node views from a patch-driven RendererStore. */
  function renderStore(store: RendererStore, options?: NormalizerOptions): string {
    return normalizeHtmlSemantics(
      renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: [], store, componentRegistry: new ComponentRegistry() })),
      options,
    );
  }

  const streamingWorker = createWorkerThread();
  let streamingStore: RendererStore | null = null;
  let workerFinalizedResolver: (() => void) | null = null;

  streamingWorker.on("message", (msg) => {
    if (msg.type === "INITIALIZED") {
      streamingStore = createRendererStore(msg.blocks);
    } else if (msg.type === "PATCH" && streamingStore) {
      streamingStore.applyPatches(msg.patches);
    } else if (msg.type === "FINALIZED") {
      if (workerFinalizedResolver) workerFinalizedResolver();
    }
  });

  async function runStreaming(text: string, chunkSize: number) {
    streamingStore = null;
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
    return {
      normalized: streamingStore ? renderStore(streamingStore) : "",
      strict: streamingStore ? renderStore(streamingStore, { strict: true }) : "",
    };
  }
  const results: ExampleResult[] = [];
  const sectionOrder: string[] = [];
  const createEmptyStats = (): EngineStats => ({
    total: 0,
    streamMdxStatic: 0,
    streamMdxSsr: 0,
    streamMdxStreaming: 0,
    micromark: 0,
    streamdown: 0,
    streamdownRaw: 0,
    streamingDivergences: 0,
  });
  const sectionStats: Record<string, EngineStats> = {};
  const strictSectionStats: Record<string, EngineStats> = {};
  for (const ex of examples) {
    if (!sectionStats[ex.section]) {
      sectionOrder.push(ex.section);
      sectionStats[ex.section] = createEmptyStats();
      strictSectionStats[ex.section] = createEmptyStats();
    }
    const stats = sectionStats[ex.section];
    const strictStats = strictSectionStats[ex.section];
    stats.total++;
    strictStats.total++;

    // Ground truth: the spec's expected HTML. micromark is a sanity column for the normalizer.
    const specNormalized = normalizeHtmlSemantics(ex.expectedHtml);
    const strictSpecNormalized = normalizeHtmlSemantics(ex.expectedHtml, { strict: true });
    const oracleRaw = micromark(ex.markdown, {
      extensions: [gfm()],
      htmlExtensions: [gfmHtml()],
      allowDangerousHtml: true,
      allowDangerousProtocol: true,
    });
    const oracleNormalized = specNormalized;
    const strictOracleNormalized = strictSpecNormalized;
    const micromarkPass = normalizeHtmlSemantics(oracleRaw) === specNormalized;
    const strictMicromarkPass = normalizeHtmlSemantics(oracleRaw, { strict: true }) === strictSpecNormalized;
    if (micromarkPass) stats.micromark++;
    if (strictMicromarkPass) strictStats.micromark++;

    // 2. StreamMDX static compile, rendered through the client store path (what StreamingMarkdown shows)
    //    and through the SSR blocks path (MarkdownBlocksRenderer without a store).
    const staticCompiled = await compileMarkdownSnapshotDirect({
      text: ex.markdown,
      init: initConfig,
    });
    const staticStore = createRendererStore(staticCompiled.blocks);
    const streamMdxStaticNormalized = renderStore(staticStore);
    const strictStreamMdxStaticNormalized = renderStore(staticStore, { strict: true });
    const streamMdxStaticPass = streamMdxStaticNormalized === oracleNormalized;
    const strictStreamMdxStaticPass = strictStreamMdxStaticNormalized === strictOracleNormalized;
    if (streamMdxStaticPass) stats.streamMdxStatic++;
    if (strictStreamMdxStaticPass) strictStats.streamMdxStatic++;
    const ssrMarkup = renderToStaticMarkup(
      React.createElement(MarkdownBlocksRenderer, { blocks: staticCompiled.blocks, componentRegistry: new ComponentRegistry() }),
    );
    const streamMdxSsrNormalized = normalizeHtmlSemantics(ssrMarkup);
    const strictStreamMdxSsrNormalized = normalizeHtmlSemantics(ssrMarkup, { strict: true });
    const streamMdxSsrPass = streamMdxSsrNormalized === oracleNormalized;
    const strictStreamMdxSsrPass = strictStreamMdxSsrNormalized === strictOracleNormalized;
    if (streamMdxSsrPass) stats.streamMdxSsr++;
    if (strictStreamMdxSsrPass) strictStats.streamMdxSsr++;

    // 3. StreamMDX Streaming (chunks: 1, 7, 64)
    let streamingMatchesStatic = true;
    let strictStreamingMatchesStatic = true;
    const chunkMatches: Record<number, boolean> = {};
    for (const size of [1, 7, 64]) {
      const streamingRes = await runStreaming(ex.markdown, size);
      const matches = streamingRes.normalized === streamMdxStaticNormalized;
      const strictMatches = streamingRes.strict === strictStreamMdxStaticNormalized;
      chunkMatches[size] = matches;
      if (!matches) {
        streamingMatchesStatic = false;
      }
      if (!strictMatches) {
        strictStreamingMatchesStatic = false;
      }
    }

    const streamingDiverged = !streamingMatchesStatic;
    if (streamingDiverged) stats.streamingDivergences++;
    const strictStreamingDiverged = !strictStreamingMatchesStatic;
    if (strictStreamingDiverged) strictStats.streamingDivergences++;
    const streamMdxStreamingPass = streamingMatchesStatic && streamMdxStaticPass;
    const strictStreamMdxStreamingPass = strictStreamingMatchesStatic && strictStreamMdxStaticPass;
    if (streamMdxStreamingPass) stats.streamMdxStreaming++;
    if (strictStreamMdxStreamingPass) strictStats.streamMdxStreaming++;

    // 4. Streamdown 2.7.0 (default chat sanitization)
    let streamdownNormalized = "";
    let strictStreamdownNormalized = "";
    let streamdownPass = false;
    let strictStreamdownPass = false;
    try {
      // linkSafety off: its default renders links as <button> (a UI choice, not a parse result).
      const sdownMarkup = renderToStaticMarkup(
        React.createElement(Streamdown, { mode: "static", linkSafety: { enabled: false } }, ex.markdown),
      );
      streamdownNormalized = normalizeHtmlSemantics(sdownMarkup);
      strictStreamdownNormalized = normalizeHtmlSemantics(sdownMarkup, { strict: true });
      streamdownPass = streamdownNormalized === oracleNormalized;
      strictStreamdownPass = strictStreamdownNormalized === strictOracleNormalized;
      if (streamdownPass) stats.streamdown++;
      if (strictStreamdownPass) strictStats.streamdown++;
    } catch (error) {
      streamdownNormalized = `RENDER_ERROR: ${error instanceof Error ? error.message : String(error)}`;
      strictStreamdownNormalized = streamdownNormalized;
    }

    // 5. Streamdown 2.7.0 (raw HTML enabled, sanitization/hardening off)
    let streamdownRawNormalized = "";
    let strictStreamdownRawNormalized = "";
    let streamdownRawPass = false;
    let strictStreamdownRawPass = false;
    try {
      const sdownRawMarkup = renderToStaticMarkup(
        React.createElement(
          Streamdown,
          { mode: "static", linkSafety: { enabled: false }, rehypePlugins: [defaultRehypePlugins.raw] },
          ex.markdown,
        ),
      );
      streamdownRawNormalized = normalizeHtmlSemantics(sdownRawMarkup);
      strictStreamdownRawNormalized = normalizeHtmlSemantics(sdownRawMarkup, { strict: true });
      streamdownRawPass = streamdownRawNormalized === oracleNormalized;
      strictStreamdownRawPass = strictStreamdownRawNormalized === strictOracleNormalized;
      if (streamdownRawPass) stats.streamdownRaw++;
      if (strictStreamdownRawPass) strictStats.streamdownRaw++;
    } catch (error) {
      streamdownRawNormalized = `RENDER_ERROR: ${error instanceof Error ? error.message : String(error)}`;
      strictStreamdownRawNormalized = streamdownRawNormalized;
    }

    results.push({
      id: ex.id,
      section: ex.section,
      number: ex.number,
      markdown: ex.markdown,
      specHtml: ex.expectedHtml,
      oracleNormalized,
      streamMdxStaticNormalized,
      streamMdxSsrNormalized,
      streamdownNormalized,
      streamdownRawNormalized,
      streamMdxStaticPass,
      streamMdxSsrPass,
      streamMdxStreamingPass,
      micromarkPass,
      streamdownPass,
      streamdownRawPass,
      streamingDiverged,
      streamingChunkMatches: chunkMatches,
      strictOracleNormalized,
      strictStreamMdxStaticNormalized,
      strictStreamMdxSsrNormalized,
      strictStreamdownNormalized,
      strictStreamdownRawNormalized,
      strictStreamMdxStaticPass,
      strictStreamMdxSsrPass,
      strictStreamMdxStreamingPass,
      strictMicromarkPass,
      strictStreamdownPass,
      strictStreamdownRawPass,
      strictStreamingDiverged,
    });
  }
  streamingWorker.terminate();
  restoreConsole();

  // Print summary table
  // Print summary tables
  const columns: Array<{ label: string; key: Exclude<keyof EngineStats, "streamingDivergences"> }> = [
    { label: "Total", key: "total" },
    { label: "StreamMDX", key: "streamMdxStatic" },
    { label: "Streaming", key: "streamMdxStreaming" },
    { label: "SSR", key: "streamMdxSsr" },
    { label: "micromark", key: "micromark" },
    { label: "Streamdown", key: "streamdown" },
    { label: "SD (raw)", key: "streamdownRaw" },
  ];

  function printTable(
    title: string,
    subtitle: string,
    statsMap: Record<string, EngineStats>,
  ): EngineStats {
    const totals: EngineStats = createEmptyStats();
    const row = (name: string, s: EngineStats) =>
      [name.length > 34 ? `${name.slice(0, 33)}…` : name.padEnd(34), ...columns.map((c) => String(s[c.key]).padStart(10))].join(" | ");
    const rule = "=".repeat(34 + columns.length * 13);

    console.log(`\n${title}`);
    if (subtitle) console.log(subtitle);
    console.log(rule);
    console.log(["Section".padEnd(34), ...columns.map((c) => c.label.padStart(10))].join(" | "));
    console.log("-".repeat(rule.length));
    for (const sec of sectionOrder) {
      const s = statsMap[sec];
      for (const key of Object.keys(totals) as Array<keyof EngineStats>) totals[key] += s[key];
      console.log(row(sec, s));
    }
    console.log(rule);
    console.log(row("TOTAL", totals));
    console.log(`Streaming divergences from static: ${totals.streamingDivergences}`);
    return totals;
  }

  const totals = printTable(
    "CommonMark & GFM Extension Conformance Report (Normalized Semantics)",
    "StreamMDX/Streaming: client store path (StreamingMarkdown). SSR: MarkdownBlocksRenderer without a store. SD (raw): Streamdown with raw HTML enabled and sanitization off.",
    sectionStats,
  );

  const strictTotals = printTable(
    "CommonMark & GFM Extension Conformance Report (STRICT: Link/Image Titles + Code Language)",
    "Preserves link/image titles and code block language-* info strings across all engines.",
    strictSectionStats,
  );

  // Write full JSON report to tmp/conformance/report.json
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  const reportPayload = {
    generatedAt: new Date().toISOString(),
    totals,
    strictTotals,
    sectionStats,
    strictSectionStats,
    results,
  };
  await fs.writeFile(REPORT_PATH, JSON.stringify(reportPayload, null, 2));
  console.log(`Wrote full report to ${REPORT_PATH}`);

  // Handle baseline update or check
  // A ratchet ID passes on every StreamMDX path: client static, client streaming, and SSR.
  const passingIds = results.filter((r) => r.streamMdxStreamingPass && r.streamMdxSsrPass).map((r) => r.id);

  if (updateBaseline) {
    const baselinePayload: BaselineFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      counts: {
        total: totals.total,
        streamMdxStatic: totals.streamMdxStatic,
        streamMdxSsr: totals.streamMdxSsr,
        streamMdxStreaming: totals.streamMdxStreaming,
        micromark: totals.micromark,
        streamdown: totals.streamdown,
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
