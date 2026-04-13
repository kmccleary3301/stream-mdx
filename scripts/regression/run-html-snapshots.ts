import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

import { chromium } from "@playwright/test";

import {
  getFixtures,
  loadScenarioFiles,
  readFixtureFile,
  splitMarkers,
  buildChunks,
  buildSeededChunks,
  progressCheckpoints,
  shouldRunScenario,
  isSplitScenario,
  firstDiffIndex,
  diffContext,
} from "./utils";
import type { RegressionScenario } from "./utils";

const UPDATE = process.env.UPDATE_SNAPSHOTS === "1" || process.env.UPDATE_SNAPSHOTS === "true";
const BASE_URL = process.env.STREAM_MDX_REGRESSION_BASE_URL || "http://localhost:3000";
const SNAPSHOT_ROOT = path.resolve(process.cwd(), "tests/regression/snapshots/html");
const ARTIFACT_ROOT = path.resolve(process.cwd(), "tests/regression/artifacts");

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readSummary(
  page: import("@playwright/test").Page,
): Promise<{ rootChildCount: number; selectors: Record<string, boolean>; counts?: Record<string, number> }> {
  const summary = (await page.evaluate(() => window.__streammdxRegression?.getSummary())) as
    | { rootChildCount: number; selectors: Record<string, boolean>; counts?: Record<string, number> }
    | undefined;
  if (summary) return summary;
  await page.waitForFunction(() => Boolean(window.__streammdxRegression));
  const retry = (await page.evaluate(() => window.__streammdxRegression?.getSummary())) as
    | { rootChildCount: number; selectors: Record<string, boolean>; counts?: Record<string, number> }
    | undefined;
  if (!retry) {
    throw new Error("Regression summary unavailable (window.__streammdxRegression missing).");
  }
  return retry;
}

type SnapshotCheckpoint = {
  id: string;
  appendedChars: number;
  rootChildCount: number;
  runtimeState?: {
    rendererVersion: number;
    queueDepth: number;
    pendingBatches: number;
    workerReady: boolean;
    lastTx: number | null;
    lastPatchToDomMs: number | null;
    lastDurationMs: number | null;
    meta?: {
      fixtureId?: string;
      scenarioId?: string;
      seed?: string;
      schedulerMode?: string;
    };
    storeCounters?: Record<string, number>;
  };
  selectors: Record<string, boolean>;
  counts?: Record<string, number>;
  html: string;
  textSample?: string;
  structure?: {
    topLevelTags: string[];
    counts: Record<string, number>;
  };
  inspection?: RenderInspection;
};

type RenderInspection = {
  tables: Array<{
    headerColumns: number;
    rowCellCounts: number[];
    emptyBodyCellCount: number;
  }>;
  mdxBlocks: Array<{
    status: string | null;
    textSample: string;
  }>;
  codeBlocks: Array<{
    text: string;
    lineCount: number;
  }>;
};

type HtmlSnapshot = {
  fixtureId: string;
  fixtureTitle: string;
  scenarioId: string;
  scenario: RegressionScenario;
  runMeta?: {
    seed?: string | null;
    schedulerMode?: string | null;
    usedSplitMarkers: boolean;
    fixtureTags: string[];
  };
  totalLength: number;
  checkpoints: SnapshotCheckpoint[];
  final: {
    id: string;
    appendedChars: number;
    rootChildCount: number;
    selectors: Record<string, boolean>;
    html: string;
    runtimeState?: SnapshotCheckpoint["runtimeState"];
    structure?: {
      topLevelTags: string[];
      counts: Record<string, number>;
    };
    children?: Array<{
      index: number;
      tag: string;
      hash: string;
      textSample: string;
    }>;
    inspection?: RenderInspection;
  };
};

async function writeSnapshot(snapshotPath: string, data: HtmlSnapshot): Promise<void> {
  await ensureDir(path.dirname(snapshotPath));
  await fs.writeFile(snapshotPath, JSON.stringify(data, null, 2));
}

async function loadSnapshot(snapshotPath: string): Promise<HtmlSnapshot | null> {
  try {
    const raw = await fs.readFile(snapshotPath, "utf8");
    return JSON.parse(raw) as HtmlSnapshot;
  } catch {
    return null;
  }
}

async function writeComparisonArtifacts(
  params: {
    fixtureId: string;
    scenarioId: string;
    label: string;
    expected: HtmlSnapshot;
    received: HtmlSnapshot;
    message: string;
  },
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeLabel = params.label.replace(/[^a-z0-9_-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const artifactDir = path.join(ARTIFACT_ROOT, stamp, params.fixtureId, params.scenarioId, safeLabel || "comparison");
  await ensureDir(artifactDir);
  await fs.writeFile(path.join(artifactDir, "expected.html"), params.expected.final.html);
  await fs.writeFile(path.join(artifactDir, "received.html"), params.received.final.html);
  await fs.writeFile(path.join(artifactDir, "expected.snap.json"), JSON.stringify(params.expected, null, 2));
  await fs.writeFile(path.join(artifactDir, "received.snap.json"), JSON.stringify(params.received, null, 2));
  await fs.writeFile(path.join(artifactDir, "message.txt"), `${params.message}\n`);
  return artifactDir;
}

function compareSnapshots(expected: HtmlSnapshot, received: HtmlSnapshot): { ok: boolean; message?: string } {
  if (expected.checkpoints.length !== received.checkpoints.length) {
    return { ok: false, message: `Checkpoint count mismatch: expected ${expected.checkpoints.length}, got ${received.checkpoints.length}` };
  }

  for (let i = 0; i < expected.checkpoints.length; i += 1) {
    const exp = expected.checkpoints[i];
    const rec = received.checkpoints[i];
    if (exp.id !== rec.id) {
      return { ok: false, message: `Checkpoint id mismatch at index ${i}: expected ${exp.id}, got ${rec.id}` };
    }
    if (exp.html !== rec.html) {
      const index = firstDiffIndex(exp.html, rec.html);
      const expectedContext = diffContext(exp.html, index);
      const receivedContext = diffContext(rec.html, index);
      return {
        ok: false,
        message: [
          `HTML mismatch at checkpoint ${exp.id}`,
          `expected lastTx: ${exp.runtimeState?.lastTx ?? "n/a"}`,
          `received lastTx: ${rec.runtimeState?.lastTx ?? "n/a"}`,
          `first diff index: ${index}`,
          `expected context: ${expectedContext}`,
          `received context: ${receivedContext}`,
        ].join("\n"),
      };
    }
    if (exp.structure && rec.structure) {
      const expStructure = JSON.stringify(exp.structure);
      const recStructure = JSON.stringify(rec.structure);
      if (expStructure !== recStructure) {
        return {
          ok: false,
          message: [
            `Structure mismatch at checkpoint ${exp.id}`,
            `expected: ${expStructure}`,
            `received: ${recStructure}`,
          ].join("\n"),
        };
      }
    }
  }

  if (expected.final.structure && received.final.structure) {
    const expStructure = JSON.stringify(expected.final.structure);
    const recStructure = JSON.stringify(received.final.structure);
    if (expStructure !== recStructure) {
      return {
        ok: false,
        message: [
          "Final structure mismatch",
          `expected: ${expStructure}`,
          `received: ${recStructure}`,
        ].join("\n"),
      };
    }
  }

  if (expected.final.children && received.final.children) {
    const expChildren = expected.final.children;
    const recChildren = received.final.children;
    const len = Math.min(expChildren.length, recChildren.length);
    for (let i = 0; i < len; i += 1) {
      if (expChildren[i]?.hash !== recChildren[i]?.hash) {
        return {
          ok: false,
          message: [
            "Final root child mismatch",
            `child index: ${i}`,
            `expected: ${expChildren[i]?.tag} ${expChildren[i]?.hash} ${expChildren[i]?.textSample ?? ""}`,
            `received: ${recChildren[i]?.tag} ${recChildren[i]?.hash} ${recChildren[i]?.textSample ?? ""}`,
          ].join("\n"),
        };
      }
    }
    if (expChildren.length !== recChildren.length) {
      return {
        ok: false,
        message: [
          "Final root child count mismatch",
          `expected: ${expChildren.length}`,
          `received: ${recChildren.length}`,
        ].join("\n"),
      };
    }
  }

  if (expected.final.html !== received.final.html) {
    const index = firstDiffIndex(expected.final.html, received.final.html);
    const expectedContext = diffContext(expected.final.html, index);
    const receivedContext = diffContext(received.final.html, index);
    return {
      ok: false,
      message: [
        `Final HTML mismatch`,
        `expected lastTx: ${expected.final.runtimeState?.lastTx ?? "n/a"}`,
        `received lastTx: ${received.final.runtimeState?.lastTx ?? "n/a"}`,
        `first diff index: ${index}`,
        `expected context: ${expectedContext}`,
        `received context: ${receivedContext}`,
      ].join("\n"),
    };
  }

  return { ok: true };
}

function compareFinalSnapshots(expected: HtmlSnapshot, received: HtmlSnapshot): { ok: boolean; message?: string } {
  if (expected.final.structure && received.final.structure) {
    const expStructure = JSON.stringify(expected.final.structure);
    const recStructure = JSON.stringify(received.final.structure);
    if (expStructure !== recStructure) {
      return {
        ok: false,
        message: [
          "Final structure mismatch",
          `expected: ${expStructure}`,
          `received: ${recStructure}`,
        ].join("\n"),
      };
    }
  }

  if (expected.final.children && received.final.children) {
    const expChildren = expected.final.children;
    const recChildren = received.final.children;
    const len = Math.min(expChildren.length, recChildren.length);
    for (let i = 0; i < len; i += 1) {
      if (expChildren[i]?.hash !== recChildren[i]?.hash) {
        return {
          ok: false,
          message: [
            "Final root child mismatch",
            `child index: ${i}`,
            `expected: ${expChildren[i]?.tag} ${expChildren[i]?.hash} ${expChildren[i]?.textSample ?? ""}`,
            `received: ${recChildren[i]?.tag} ${recChildren[i]?.hash} ${recChildren[i]?.textSample ?? ""}`,
          ].join("\n"),
        };
      }
    }
    if (expChildren.length !== recChildren.length) {
      return {
        ok: false,
        message: [
          "Final root child count mismatch",
          `expected: ${expChildren.length}`,
          `received: ${recChildren.length}`,
        ].join("\n"),
      };
    }
  }

  if (expected.final.html !== received.final.html) {
    const index = firstDiffIndex(expected.final.html, received.final.html);
    const expectedContext = diffContext(expected.final.html, index);
    const receivedContext = diffContext(received.final.html, index);
    return {
      ok: false,
      message: [
        "Final HTML mismatch",
        `expected lastTx: ${expected.final.runtimeState?.lastTx ?? "n/a"}`,
        `received lastTx: ${received.final.runtimeState?.lastTx ?? "n/a"}`,
        `first diff index: ${index}`,
        `expected context: ${expectedContext}`,
        `received context: ${receivedContext}`,
      ].join("\n"),
    };
  }

  return { ok: true };
}

function hashHtml(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function readRootText(page: import("@playwright/test").Page): Promise<string> {
  return await page.evaluate(() => {
    const root = document.getElementById("regression-root");
    return root?.textContent ?? "";
  });
}

async function readStructure(page: import("@playwright/test").Page): Promise<{ topLevelTags: string[]; counts: Record<string, number> }> {
  return await page.evaluate(() => {
    const root = document.getElementById("regression-root");
    const topLevelTags = root ? Array.from(root.children).map((child) => child.tagName.toLowerCase()) : [];
    const counts: Record<string, number> = {
      table: root?.querySelectorAll("table").length ?? 0,
      pre: root?.querySelectorAll("pre").length ?? 0,
      blockquote: root?.querySelectorAll("blockquote").length ?? 0,
      katex: root?.querySelectorAll(".katex").length ?? 0,
      mdxPending: root?.querySelectorAll('.markdown-mdx[data-mdx-status="pending"]').length ?? 0,
      mdxCompiled: root?.querySelectorAll('.markdown-mdx[data-mdx-status="compiled"]').length ?? 0,
      footnotes: root?.querySelectorAll(".footnotes").length ?? 0,
      hr: root?.querySelectorAll("hr").length ?? 0,
    };
    return { topLevelTags, counts };
  });
}

async function readRootChildren(page: import("@playwright/test").Page): Promise<Array<{ tag: string; html: string; text: string }>> {
  return await page.evaluate(() => {
    const root = document.getElementById("regression-root");
    if (!root) return [];
    return Array.from(root.children).map((child) => ({
      tag: child.tagName.toLowerCase(),
      html: child.outerHTML,
      text: (child.textContent ?? "").slice(0, 120),
    }));
  });
}

async function readInspection(page: import("@playwright/test").Page): Promise<RenderInspection> {
  return await page.evaluate(() => {
    const root = document.getElementById("regression-root");
    if (!root) {
      return { tables: [], mdxBlocks: [], codeBlocks: [] };
    }

    const tables = Array.from(root.querySelectorAll("table")).map((table) => {
      const headerRow = table.querySelector("thead tr");
      const headerColumns = headerRow ? headerRow.querySelectorAll("th,td").length : 0;
      const bodyRows = Array.from(table.querySelectorAll("tbody tr"));
      const rowCellCounts = bodyRows.map((row) => row.querySelectorAll("td,th").length);
      let emptyBodyCellCount = 0;
      for (const row of bodyRows) {
        for (const cell of Array.from(row.querySelectorAll("td,th"))) {
          if ((cell.textContent ?? "").trim().length === 0) {
            emptyBodyCellCount += 1;
          }
        }
      }
      return { headerColumns, rowCellCounts, emptyBodyCellCount };
    });

    const mdxBlocks = Array.from(root.querySelectorAll(".markdown-mdx")).map((node) => ({
      status: node instanceof HTMLElement ? node.dataset.mdxStatus ?? null : null,
      textSample: (node.textContent ?? "").slice(0, 160),
    }));

    const codeBlocks = Array.from(root.querySelectorAll("pre code")).map((node) => {
      const text = (node.textContent ?? "").replace(/\r\n?/g, "\n");
      return {
        text,
        lineCount: text.length === 0 ? 0 : text.split("\n").length,
      };
    });

    return { tables, mdxBlocks, codeBlocks };
  });
}

function normalizeCodeText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function getSchedulerPreset(mode: string | null): Record<string, unknown> | null {
  if (!mode) return null;
  const presets: Record<string, Record<string, unknown>> = {
    smooth: {
      scheduling: {
        batch: "rAF",
        frameBudgetMs: 6,
        maxBatchesPerFlush: 4,
        lowPriorityFrameBudgetMs: 3,
        maxLowPriorityBatchesPerFlush: 1,
        urgentQueueThreshold: 2,
      },
    },
    timeout: {
      scheduling: {
        batch: "timeout",
        frameBudgetMs: 8,
        maxBatchesPerFlush: 8,
        lowPriorityFrameBudgetMs: 4,
        maxLowPriorityBatchesPerFlush: 2,
        urgentQueueThreshold: 3,
      },
    },
    microtask: {
      scheduling: {
        batch: "microtask",
        frameBudgetMs: 10,
        maxBatchesPerFlush: 12,
        lowPriorityFrameBudgetMs: 6,
        maxLowPriorityBatchesPerFlush: 2,
        urgentQueueThreshold: 4,
      },
    },
  };
  return presets[mode] ?? null;
}

function validateTableInspection(
  fixture: ReturnType<typeof getFixtures>[number],
  inspection: RenderInspection,
  label: string,
  failures: string[],
): void {
  if (!fixture.forbidIncompleteTableRows) return;
  const expectedColumns = fixture.expectedTableColumnCount ?? null;
  inspection.tables.forEach((table, tableIndex) => {
    const targetColumns = expectedColumns ?? table.headerColumns;
    if (targetColumns <= 0) {
      failures.push(`${label}: table ${tableIndex} has no header columns.`);
      return;
    }
    if (table.headerColumns > 0 && table.headerColumns !== targetColumns) {
      failures.push(`${label}: table ${tableIndex} header column mismatch (${table.headerColumns} vs ${targetColumns}).`);
    }
    table.rowCellCounts.forEach((cellCount, rowIndex) => {
      if (cellCount !== targetColumns) {
        failures.push(`${label}: table ${tableIndex} row ${rowIndex} cell count mismatch (${cellCount} vs ${targetColumns}).`);
      }
    });
  });
}

function validateCodePrefixInvariant(
  fixture: ReturnType<typeof getFixtures>[number],
  checkpoints: SnapshotCheckpoint[],
  finalInspection: RenderInspection,
  failures: string[],
): void {
  if (!fixture.enforceCodeTextPrefix) return;
  const finalCodeBlocks = finalInspection.codeBlocks.map((block) => normalizeCodeText(block.text));
  if (typeof fixture.expectedCodeBlockCount === "number" && finalCodeBlocks.length !== fixture.expectedCodeBlockCount) {
    failures.push(`final code block count mismatch: expected ${fixture.expectedCodeBlockCount}, got ${finalCodeBlocks.length}.`);
  }

  const previousLineCounts = new Map<number, number>();
  for (const checkpoint of checkpoints) {
    const codeBlocks = checkpoint.inspection?.codeBlocks ?? [];
    if (codeBlocks.length > finalCodeBlocks.length) {
      failures.push(`${checkpoint.id}: code block count exceeded final count (${codeBlocks.length} > ${finalCodeBlocks.length}).`);
      continue;
    }
    codeBlocks.forEach((block, index) => {
      const currentText = normalizeCodeText(block.text);
      const finalText = finalCodeBlocks[index] ?? "";
      if (finalText && !finalText.startsWith(currentText)) {
        failures.push(`${checkpoint.id}: code block ${index} is not a prefix of final rendered text.`);
      }
      const previousLineCount = previousLineCounts.get(index) ?? 0;
      if (block.lineCount < previousLineCount) {
        failures.push(`${checkpoint.id}: code block ${index} line count regressed (${previousLineCount} -> ${block.lineCount}).`);
      }
      previousLineCounts.set(index, block.lineCount);
    });
  }
}

async function run(): Promise<void> {
  const fixtureFilter = getArg("--filter");
  const scenarioFilter = getArg("--scenario");
  const seed = getArg("--seed");
  const seedCountRaw = getArg("--seed-count");
  const schedulerMode = getArg("--scheduler");
  const seedCount = seedCountRaw ? Math.max(1, Number.parseInt(seedCountRaw, 10) || 1) : 1;
  const requestedSeeds =
    seedCount > 1
      ? Array.from({ length: seedCount }, (_, index) => `${seed ?? "seed"}-${index + 1}`)
      : [seed ?? null];
  const replayMode = requestedSeeds.some((value) => value !== null) || Boolean(schedulerMode);

  const fixtures = getFixtures().filter((fixture) => (fixtureFilter ? fixture.id.includes(fixtureFilter) : true));
  const scenarios = (await loadScenarioFiles()).filter((scenario) => (scenarioFilter ? scenario.id.includes(scenarioFilter) : true));

  if (fixtures.length === 0) {
    console.error("No fixtures matched filter.");
    process.exitCode = 1;
    return;
  }
  if (scenarios.length === 0) {
    console.error("No scenarios matched filter.");
    process.exitCode = 1;
    return;
  }

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const suppressedConsole = {
    nameNotResolved: 0,
    nameNotResolvedByFixture: {} as Record<string, number>,
  };
  const ignored404Patterns = ["/favicon.ico", "/robots.txt", "/apple-touch-icon", "/site.webmanifest"];
  const unexpected404Urls = new Set<string>();
  let suppressNameNotResolved = false;
  let currentFixtureId = "unknown";
  const attachPageObservers = (page: import("@playwright/test").Page) => {
    page.on("pageerror", (error) => {
      console.error(`\n[regression pageerror] ${error}`);
    });
    page.on("response", (response) => {
      if (response.status() !== 404) return;
      const url = response.url();
      if (ignored404Patterns.some((pattern) => url.includes(pattern))) {
        return;
      }
      if (unexpected404Urls.has(url)) {
        return;
      }
      unexpected404Urls.add(url);
      console.error(`\n[regression http404] ${url}`);
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        const text = message.text();
        if (text.includes("Failed to load resource: the server responded with a status of 404")) {
          return;
        }
        if (text.includes("net::ERR_NAME_NOT_RESOLVED") && suppressNameNotResolved) {
          suppressedConsole.nameNotResolved += 1;
          suppressedConsole.nameNotResolvedByFixture[currentFixtureId] =
            (suppressedConsole.nameNotResolvedByFixture[currentFixtureId] ?? 0) + 1;
          return;
        }
        console.error(`\n[regression console.${message.type()}] ${text}`);
      }
    });
  };

  let failures = 0;

  for (const fixture of fixtures) {
    currentFixtureId = fixture.id;
    suppressNameNotResolved = (fixture.tags ?? []).includes("mdx");
    const rawContent = await readFixtureFile(fixture.file);

    for (const scenario of scenarios) {
      if (!shouldRunScenario(fixture, scenario)) continue;

      const split = splitMarkers(rawContent);
      const text = split ? split.text : rawContent;
      const snapshotPath = path.join(SNAPSHOT_ROOT, fixture.id, `${scenario.id}.snap.json`);
      const expected = await loadSnapshot(snapshotPath);
      let scenarioFailed = false;
      let baselineReplaySnapshot: HtmlSnapshot | null = null;

      for (const activeSeed of requestedSeeds) {
        const page = await context.newPage();
        attachPageObservers(page);
        const chunks = isSplitScenario(scenario) && split
          ? split.chunks
          : activeSeed
            ? buildSeededChunks(text, scenario, `${fixture.id}:${scenario.id}:${activeSeed}`)
            : buildChunks(text, scenario);
        const enforcePrefixInvariant = !["article", "footnotes", "html", "lists", "math", "mdx", "table"].some((tag) =>
          (fixture.tags ?? []).includes(tag),
        );
        const waitForMdxCompiled = fixture.waitForMdxCompiled ?? (fixture.tags ?? []).includes("mdx");
        const tableTargetPct = fixture.expectTableByPct;
        const tableTargetChars =
          typeof tableTargetPct === "number" && scenario.maxChunkChars <= 512
            ? Math.max(1, Math.round(text.length * tableTargetPct))
            : null;
        const progressTargets = progressCheckpoints(text.length);
        const checkpointTargets = [...progressTargets];
        const checkpointSet = new Set<number>();
        const seenEvents: Record<string, boolean> = {
          hasTable: false,
          hasPre: false,
          hasFootnotes: false,
          hasMdxPending: false,
          hasMdxCompiled: false,
          hasBlockquote: false,
          hasMath: false,
        };
        const checkpoints: SnapshotCheckpoint[] = [];

        try {
          await page.goto(`${BASE_URL}/regression/html/`, { waitUntil: "load" });
          await page.waitForFunction(() => Boolean(window.__streammdxRegression));
          await page.evaluate(
            async ({ fixtureId, scenarioId, nextSeed, nextSchedulerMode, preset }) => {
              window.__streammdxRegression?.setMeta({
                fixtureId,
                scenarioId,
                seed: nextSeed,
                schedulerMode: nextSchedulerMode,
              });
              if (preset && window.__streammdxRegression?.setConfig) {
                await window.__streammdxRegression.setConfig(preset);
              }
            },
            {
              fixtureId: fixture.id,
              scenarioId: scenario.id,
              nextSeed: activeSeed,
              nextSchedulerMode: schedulerMode,
              preset: getSchedulerPreset(schedulerMode),
            },
          );
          await page.evaluate(() => window.__streammdxRegression?.waitForReady());

          let appended = 0;
          let firstChunkCaptured = false;
          let tableFirstSeenAt: number | null = null;
          let lastCheckpointText = "";
          let lastCheckpointChildCount = 0;
          const streamInvariantFailures: string[] = [];

          const captureCheckpoint = async (
            id: string,
            summary: { rootChildCount: number; selectors: Record<string, boolean>; counts?: Record<string, number> },
          ) => {
            const html = await page.evaluate(() => window.__streammdxRegression?.getHtml());
            const runtimeState = (await page.evaluate(
              () => window.__streammdxRegression?.getRuntimeState?.(),
            )) as SnapshotCheckpoint["runtimeState"];
            const structure = await readStructure(page);
            const inspection = await readInspection(page);
            const textContent = await readRootText(page);
            if (
              enforcePrefixInvariant &&
              !summary.selectors.hasMdxPending &&
              lastCheckpointText &&
              !textContent.startsWith(lastCheckpointText)
            ) {
              streamInvariantFailures.push(`text prefix invariant failed at ${id} (${fixture.id}/${scenario.id}).`);
            }
            if (summary.rootChildCount < lastCheckpointChildCount) {
              streamInvariantFailures.push(`${id}: root child count decreased (${lastCheckpointChildCount} -> ${summary.rootChildCount}).`);
            }
            if (fixture.forbidIncompleteTableRowsDuringStreaming) {
              validateTableInspection(fixture, inspection, id, streamInvariantFailures);
            }
            lastCheckpointText = textContent;
            lastCheckpointChildCount = summary.rootChildCount;
            checkpoints.push({
              id,
              appendedChars: appended,
              rootChildCount: summary.rootChildCount,
              runtimeState,
              selectors: summary.selectors,
              counts: summary.counts,
              html: html ?? "",
              textSample: textContent.slice(0, 200),
              structure,
              inspection,
            });
          };

          for (const chunk of chunks) {
            await page.evaluate((value) => window.__streammdxRegression?.appendAndFlush(value), chunk);
            appended += chunk.length;

            const summary = await readSummary(page);
            if (tableFirstSeenAt === null && summary.selectors.hasTable) {
              tableFirstSeenAt = appended;
            }
            if (summary.counts?.table && tableFirstSeenAt === null) {
              tableFirstSeenAt = appended;
            }

          if (!firstChunkCaptured) {
            await captureCheckpoint("after-first-chunk", summary);
            firstChunkCaptured = true;
          }

          while (checkpointTargets.length > 0 && appended >= checkpointTargets[0]) {
            const target = checkpointTargets.shift();
            if (target !== undefined && !checkpointSet.has(target)) {
              checkpointSet.add(target);
              await captureCheckpoint(`progress-${target}`, summary);
            }
          }

          for (const [key, value] of Object.entries(summary.selectors)) {
            if (value && !seenEvents[key]) {
              seenEvents[key] = true;
              await captureCheckpoint(`event-${key}`, summary);
            }
          }

          if ((fixture.forbidSelectorsDuringStreaming?.length ?? 0) > 0) {
            const forbiddenDuringStreaming = (await page.evaluate((selectors) => {
              const root = document.getElementById("regression-root");
              if (!root) return selectors;
              return selectors.filter((selector) => root.querySelector(selector));
            }, fixture.forbidSelectorsDuringStreaming ?? [])) as string[];
            if (forbiddenDuringStreaming.length > 0) {
              streamInvariantFailures.push(
                `forbidden selectors visible during streaming: ${forbiddenDuringStreaming.join(", ")}.`,
              );
            }
          }
        }

          await page.evaluate(() => window.__streammdxRegression?.finalizeAndFlush());

        if (waitForMdxCompiled) {
          try {
            await page.waitForFunction(() => {
              const summary = window.__streammdxRegression?.getSummary();
              if (!summary) return false;
              return summary.selectors.hasMdxCompiled && !summary.selectors.hasMdxPending;
            });
          } catch (error) {
            failures += 1;
            scenarioFailed = true;
            console.error(`\nMDX compile timeout for ${fixture.id}/${scenario.id} seed=${activeSeed ?? "baseline"}`);
            console.error(error);
          }
        }

          const invariantViolations = (await page.evaluate(
          () => window.__streammdxRegression?.getInvariantViolations?.() ?? [],
        )) as { message: string }[];
        if (streamInvariantFailures.length > 0) {
          failures += 1;
          scenarioFailed = true;
          console.error(`\nStreaming invariant violations for ${fixture.id}/${scenario.id} seed=${activeSeed ?? "baseline"}:`);
          for (const message of streamInvariantFailures) {
            console.error(`- ${message}`);
          }
        }
        if (invariantViolations.length > 0) {
          failures += 1;
          scenarioFailed = true;
          console.error(`\nInvariant violations for ${fixture.id}/${scenario.id} seed=${activeSeed ?? "baseline"}:`);
          for (const violation of invariantViolations) {
            console.error(`- ${violation.message}`);
          }
        }

          const finalSummary = (await page.evaluate(() => window.__streammdxRegression?.getSummary())) as {
          rootChildCount: number;
          selectors: Record<string, boolean>;
          counts?: Record<string, number>;
        };
        for (const [key, value] of Object.entries(finalSummary.selectors)) {
          if (value && !seenEvents[key]) {
            seenEvents[key] = true;
            await captureCheckpoint(`event-${key}`, finalSummary);
          }
        }
          const finalHtml = await page.evaluate(() => window.__streammdxRegression?.getHtml());
          const finalRuntimeState = (await page.evaluate(
          () => window.__streammdxRegression?.getRuntimeState?.(),
        )) as SnapshotCheckpoint["runtimeState"];
          const finalStructure = await readStructure(page);
          const finalInspection = await readInspection(page);
          const rootChildren = await readRootChildren(page);
        const childHashes = rootChildren.map((child, index) => ({
          index,
          tag: child.tag,
          hash: hashHtml(child.html),
          textSample: child.text,
        }));
        const htmlInvariantFailures: string[] = [];
        const finalHtmlValue = finalHtml ?? "";
        const rawBlockMathNeedle = '<p class="markdown-paragraph">$$';
        const rawInlineCodeNeedle =
          "`this is a really really really really really really really really really really really really really really really really really really really really really long inline code span`";
        const isSanitizationFixture = (fixture.tags ?? []).includes("sanitization");
        const emptyNestedListCount = fixture.forbidEmptyNestedLists
          ? await page.evaluate(() => {
              const root = document.getElementById("regression-root");
              if (!root) return 0;
              const nestedLists = root.querySelectorAll(
                ".markdown-list-item-children > ol.markdown-list, .markdown-list-item-children > ul.markdown-list",
              );
              let emptyCount = 0;
              for (const list of nestedLists) {
                const hasItems = Array.from(list.children).some(
                  (child) => child instanceof HTMLElement && child.classList.contains("markdown-list-item"),
                );
                if (!hasItems) emptyCount += 1;
              }
              return emptyCount;
            })
          : 0;

        if (finalHtmlValue.includes(rawBlockMathNeedle)) {
          htmlInvariantFailures.push("raw block math detected in paragraph (expected KaTeX output).");
        }
        if (finalHtmlValue.includes(rawInlineCodeNeedle)) {
          htmlInvariantFailures.push("raw backtick inline code detected (expected <code> output).");
        }
        if (emptyNestedListCount > 0) {
          htmlInvariantFailures.push(`empty nested list container detected (${emptyNestedListCount}).`);
        }
        if (isSanitizationFixture) {
          if (finalHtmlValue.includes("<script")) {
            htmlInvariantFailures.push("sanitization failure: <script> tag present.");
          }
          if (finalHtmlValue.includes("onerror=")) {
            htmlInvariantFailures.push("sanitization failure: onerror attribute present.");
          }
          if (finalHtmlValue.includes("onclick=")) {
            htmlInvariantFailures.push("sanitization failure: onclick attribute present.");
          }
        }
        if (tableTargetChars !== null && (tableFirstSeenAt === null || tableFirstSeenAt > tableTargetChars)) {
          htmlInvariantFailures.push(
            `table was not visible by ${Math.round(tableTargetPct! * 100)}% (first seen at ${tableFirstSeenAt ?? "never"} / ${tableTargetChars} chars).`,
          );
        }
        if (typeof fixture.expectedListItemCount === "number") {
          const listItemCount = await page.evaluate(() => {
            const root = document.getElementById("regression-root");
            return root?.querySelectorAll("li").length ?? 0;
          });
          if (listItemCount !== fixture.expectedListItemCount) {
            htmlInvariantFailures.push(`list item count mismatch: expected ${fixture.expectedListItemCount}, got ${listItemCount}.`);
          }
        }
        if (fixture.requiredTextFragments?.length) {
          const missingFragments = fixture.requiredTextFragments.filter((fragment) => !finalHtmlValue.includes(fragment));
          if (missingFragments.length > 0) {
            htmlInvariantFailures.push(`missing required text fragments: ${missingFragments.join(", ")}.`);
          }
        }
        if (fixture.forbidTextFragments?.length) {
          const presentForbiddenFragments = fixture.forbidTextFragments.filter((fragment) => finalHtmlValue.includes(fragment));
          if (presentForbiddenFragments.length > 0) {
            htmlInvariantFailures.push(`forbidden text fragments present: ${presentForbiddenFragments.join(", ")}.`);
          }
        }
        if (typeof fixture.expectedMdxBlockCount === "number" && finalInspection.mdxBlocks.length !== fixture.expectedMdxBlockCount) {
          htmlInvariantFailures.push(
            `final mdx block count mismatch: expected ${fixture.expectedMdxBlockCount}, got ${finalInspection.mdxBlocks.length}.`,
          );
        }
        validateTableInspection(fixture, finalInspection, "after-finalize", htmlInvariantFailures);
        validateCodePrefixInvariant(fixture, checkpoints, finalInspection, htmlInvariantFailures);

        if (htmlInvariantFailures.length > 0) {
          failures += 1;
          scenarioFailed = true;
          console.error(`\nHTML invariant violations for ${fixture.id}/${scenario.id} seed=${activeSeed ?? "baseline"}:`);
          for (const message of htmlInvariantFailures) {
            console.error(`- ${message}`);
          }
        }

        const requiredSelectors = fixture.requiredSelectors ?? [];
        if (requiredSelectors.length > 0) {
          const missing = (await page.evaluate((selectors) => {
            const root = document.getElementById("regression-root");
            if (!root) return selectors;
            return selectors.filter((selector) => !root.querySelector(selector));
          }, requiredSelectors)) as string[];
          if (missing.length > 0) {
            failures += 1;
            scenarioFailed = true;
            console.error(`\nMissing required selectors for ${fixture.id}/${scenario.id} seed=${activeSeed ?? "baseline"}: ${missing.join(", ")}`);
          }
        }
        const forbidSelectors = fixture.forbidSelectors ?? [];
        if (forbidSelectors.length > 0) {
          const presentForbidden = (await page.evaluate((selectors) => {
            const root = document.getElementById("regression-root");
            if (!root) return [];
            return selectors.filter((selector) => root.querySelector(selector));
          }, forbidSelectors)) as string[];
          if (presentForbidden.length > 0) {
            failures += 1;
            scenarioFailed = true;
            console.error(
              `\nForbidden selectors present for ${fixture.id}/${scenario.id} seed=${activeSeed ?? "baseline"}: ${presentForbidden.join(", ")}`,
            );
          }
        }

          const snapshot: HtmlSnapshot = {
          fixtureId: fixture.id,
          fixtureTitle: fixture.title,
          scenarioId: scenario.id,
          scenario,
          runMeta: {
            seed: activeSeed,
            schedulerMode,
            usedSplitMarkers: isSplitScenario(scenario) && Boolean(split),
            fixtureTags: [...(fixture.tags ?? [])],
          },
          totalLength: text.length,
          checkpoints,
          final: {
            id: "after-finalize",
            appendedChars: appended,
            rootChildCount: finalSummary.rootChildCount,
            selectors: finalSummary.selectors,
            html: finalHtml ?? "",
            runtimeState: finalRuntimeState,
            structure: finalStructure,
            children: childHashes,
            inspection: finalInspection,
          },
        };

          if (!replayMode) {
          if (UPDATE) {
            if (scenarioFailed) {
              console.warn(`skipped update for ${fixture.id}/${scenario.id} due to failures`);
            } else {
              await writeSnapshot(snapshotPath, snapshot);
              console.log(`updated ${fixture.id}/${scenario.id}`);
            }
            continue;
          }

          if (!expected) {
            console.error(`missing snapshot for ${fixture.id}/${scenario.id}`);
            failures += 1;
            scenarioFailed = true;
            continue;
          }

          const result = compareSnapshots(expected, snapshot);
          if (!result.ok) {
            failures += 1;
            const artifactDir = await writeComparisonArtifacts({
              fixtureId: fixture.id,
              scenarioId: scenario.id,
              label: "baseline-regression",
              expected,
              received: snapshot,
              message: result.message ?? "HTML regression",
            });
            console.error(`\nHTML regression: ${fixture.id} / ${scenario.id}\n${result.message}\n`);
            console.error(`artifacts: ${artifactDir}`);
          } else {
            console.log(`ok ${fixture.id}/${scenario.id}`);
          }
          continue;
        }

          if (UPDATE) {
          console.warn(`skipping snapshot update in replay mode for ${fixture.id}/${scenario.id}`);
        }
          if (expected) {
          const result = compareFinalSnapshots(expected, snapshot);
          if (!result.ok) {
            failures += 1;
            scenarioFailed = true;
            const artifactDir = await writeComparisonArtifacts({
              fixtureId: fixture.id,
              scenarioId: scenario.id,
              label: `baseline-parity-${activeSeed ?? "baseline"}`,
              expected,
              received: snapshot,
              message: result.message ?? "Final HTML parity mismatch vs baseline snapshot",
            });
            console.error(
              `\nFinal HTML parity mismatch vs baseline snapshot for ${fixture.id}/${scenario.id} seed=${activeSeed ?? "baseline"}\n${result.message ?? ""}\n`,
            );
            console.error(`artifacts: ${artifactDir}`);
          }
        }
          if (!baselineReplaySnapshot) {
          baselineReplaySnapshot = snapshot;
        } else {
          const replayResult = compareFinalSnapshots(baselineReplaySnapshot, snapshot);
          if (!replayResult.ok) {
            failures += 1;
            scenarioFailed = true;
            const artifactDir = await writeComparisonArtifacts({
              fixtureId: fixture.id,
              scenarioId: scenario.id,
              label: `replay-divergence-${baselineReplaySnapshot.runMeta?.seed ?? "baseline"}-vs-${activeSeed ?? "baseline"}`,
              expected: baselineReplaySnapshot,
              received: snapshot,
              message: replayResult.message ?? "Replay divergence",
            });
            console.error(
              `\nReplay divergence for ${fixture.id}/${scenario.id}: baseline seed=${baselineReplaySnapshot.runMeta?.seed ?? "baseline"} vs ${activeSeed ?? "baseline"}\n${replayResult.message ?? ""}\n`,
            );
            console.error(`artifacts: ${artifactDir}`);
          } else if (!scenarioFailed) {
            console.log(`ok ${fixture.id}/${scenario.id} seed=${activeSeed ?? "baseline"}`);
          }
          }
        } finally {
          await page.close();
        }
      }
    }
  }

  await context.close();
  await browser.close();

  if (suppressedConsole.nameNotResolved > 0) {
    const details = Object.entries(suppressedConsole.nameNotResolvedByFixture)
      .map(([fixtureId, count]) => `${fixtureId}=${count}`)
      .join(", ");
    const suffix = details ? ` (${details})` : "";
    console.warn(
      `[regression console] suppressed ${suppressedConsole.nameNotResolved} net::ERR_NAME_NOT_RESOLVED errors${suffix}`,
    );
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
