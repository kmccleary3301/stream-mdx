import fs from "node:fs/promises";
import path from "node:path";

import { chromium, type Browser, type Page } from "@playwright/test";

import {
  buildSeededChunks,
  diffContext,
  firstDiffIndex,
  getFixtures,
  loadScenarioFiles,
  readFixtureFile,
  splitMarkers,
} from "./utils";

type SchedulerMode = "microtask" | "smooth" | "timeout";

type Case = {
  fixture: string;
  scenario: string;
};

type RegressionApi = {
  setConfig?: (next: Record<string, unknown>) => Promise<void>;
  setMeta?: (meta: { fixtureId?: string; scenarioId?: string; seed?: string; schedulerMode?: string }) => void;
  appendAndFlush?: (chunk: string) => Promise<void>;
  finalizeAndFlush?: () => Promise<void>;
  waitForReady?: () => Promise<void>;
  getHtml?: () => string;
  getRuntimeState?: () => {
    lastTx: number | null;
  };
};

declare global {
  interface Window {
    __streammdxRegression?: RegressionApi;
  }
}

const BASE_URL = process.env.STREAM_MDX_REGRESSION_BASE_URL ?? "http://127.0.0.1:3012";
const ARTIFACT_ROOT = path.resolve(process.cwd(), "tests/regression/artifacts", "scheduler-parity");
const MODES: SchedulerMode[] = ["microtask", "smooth", "timeout"];
const CASES: Case[] = [
  { fixture: "edge-regressions", scenario: "S2_typical" },
  { fixture: "mdx-transitions", scenario: "S2_typical" },
  { fixture: "table-boundary", scenario: "S2_typical" },
];

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function getSchedulerPreset(mode: SchedulerMode): Record<string, unknown> {
  switch (mode) {
    case "smooth":
      return {
        scheduling: {
          batch: "rAF",
          frameBudgetMs: 6,
          maxBatchesPerFlush: 4,
          lowPriorityFrameBudgetMs: 3,
          maxLowPriorityBatchesPerFlush: 1,
          urgentQueueThreshold: 2,
        },
      };
    case "timeout":
      return {
        scheduling: {
          batch: "timeout",
          frameBudgetMs: 8,
          maxBatchesPerFlush: 8,
          lowPriorityFrameBudgetMs: 4,
          maxLowPriorityBatchesPerFlush: 2,
          urgentQueueThreshold: 3,
        },
      };
    case "microtask":
    default:
      return {
        scheduling: {
          batch: "microtask",
          frameBudgetMs: 10,
          maxBatchesPerFlush: 12,
          lowPriorityFrameBudgetMs: 6,
          maxLowPriorityBatchesPerFlush: 2,
          urgentQueueThreshold: 4,
        },
      };
  }
}

async function preparePage(page: Page, fixtureId: string, scenarioId: string, seed: string, mode: SchedulerMode): Promise<void> {
  await page.goto(`${BASE_URL}/regression/html/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__streammdxRegression));
  await page.evaluate(
    async ({ fixtureId: nextFixtureId, scenarioId: nextScenarioId, nextSeed, nextMode, preset }) => {
      window.__streammdxRegression?.setMeta?.({
        fixtureId: nextFixtureId,
        scenarioId: nextScenarioId,
        seed: nextSeed,
        schedulerMode: nextMode,
      });
      if (preset) {
        await window.__streammdxRegression?.setConfig?.(preset as Record<string, unknown>);
      }
      await window.__streammdxRegression?.waitForReady?.();
    },
    {
      fixtureId,
      scenarioId,
      nextSeed: seed,
      nextMode: mode,
      preset: getSchedulerPreset(mode),
    },
  );
}

async function captureFinalHtml(
  browser: Browser,
  testCase: Case,
  seed: string,
  mode: SchedulerMode,
): Promise<{ html: string; lastTx: number | null }> {
  const fixture = getFixtures().find((item) => item.id === testCase.fixture);
  const scenario = (await loadScenarioFiles()).find((item) => item.id === testCase.scenario);
  if (!fixture || !scenario) {
    throw new Error(`Missing fixture/scenario for ${testCase.fixture}/${testCase.scenario}`);
  }
  const raw = await readFixtureFile(fixture.file);
  const split = splitMarkers(raw);
  const text = split?.text ?? raw;
  const chunks = buildSeededChunks(text, scenario, seed);

  const page = await browser.newPage();
  try {
    await preparePage(page, fixture.id, scenario.id, seed, mode);
    for (const chunk of chunks) {
      await page.evaluate(async (value) => {
        await window.__streammdxRegression?.appendAndFlush?.(value);
      }, chunk);
    }
    await page.evaluate(async () => {
      await window.__streammdxRegression?.finalizeAndFlush?.();
    });
    const result = await page.evaluate(() => ({
      html: window.__streammdxRegression?.getHtml?.() ?? "",
      lastTx: window.__streammdxRegression?.getRuntimeState?.().lastTx ?? null,
    }));
    return result;
  } finally {
    await page.close();
  }
}

async function writeParityArtifacts(params: {
  testCase: Case;
  seed: string;
  baselineMode: SchedulerMode;
  candidateMode: SchedulerMode;
  baseline: { html: string; lastTx: number | null };
  candidate: { html: string; lastTx: number | null };
  index: number;
  expectedContext: string;
  receivedContext: string;
}): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(
    ARTIFACT_ROOT,
    stamp,
    params.testCase.fixture,
    params.testCase.scenario,
    `${params.seed}-${params.baselineMode}-vs-${params.candidateMode}`,
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "baseline.html"), params.baseline.html);
  await fs.writeFile(path.join(dir, "candidate.html"), params.candidate.html);
  await fs.writeFile(
    path.join(dir, "summary.json"),
    JSON.stringify(
      {
        fixture: params.testCase.fixture,
        scenario: params.testCase.scenario,
        seed: params.seed,
        baselineMode: params.baselineMode,
        candidateMode: params.candidateMode,
        firstDiffIndex: params.index,
        baselineLastTx: params.baseline.lastTx,
        candidateLastTx: params.candidate.lastTx,
        expectedContext: params.expectedContext,
        receivedContext: params.receivedContext,
      },
      null,
      2,
    ),
  );
  return dir;
}

async function assertHtmlParity(
  testCase: Case,
  seed: string,
  baselineMode: SchedulerMode,
  candidateMode: SchedulerMode,
  baseline: { html: string; lastTx: number | null },
  candidate: { html: string; lastTx: number | null },
): void {
  if (baseline.html === candidate.html) {
    return;
  }
  const index = firstDiffIndex(baseline.html, candidate.html);
  const expectedContext = diffContext(baseline.html, index);
  const receivedContext = diffContext(candidate.html, index);
  const artifactDir = await writeParityArtifacts({
    testCase,
    seed,
    baselineMode,
    candidateMode,
    baseline,
    candidate,
    index,
    expectedContext,
    receivedContext,
  });
  throw new Error(
    [
      `Scheduler parity failed for ${testCase.fixture}/${testCase.scenario} seed=${seed}`,
      `baseline mode: ${baselineMode} lastTx=${baseline.lastTx ?? "n/a"}`,
      `candidate mode: ${candidateMode} lastTx=${candidate.lastTx ?? "n/a"}`,
      `first diff index: ${index}`,
      `baseline context: ${expectedContext}`,
      `candidate context: ${receivedContext}`,
      `artifacts: ${artifactDir}`,
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const seedCountRaw = Number(getArg("--seed-count") ?? process.env.STREAM_MDX_SCHEDULER_PARITY_SEEDS ?? "2");
  const seedCount = Number.isFinite(seedCountRaw) && seedCountRaw > 0 ? Math.floor(seedCountRaw) : 2;
  const browser = await chromium.launch({ headless: true });
  try {
    console.log(`[scheduler-parity] baseUrl=${BASE_URL}`);
    for (const testCase of CASES) {
      for (let seedIndex = 1; seedIndex <= seedCount; seedIndex += 1) {
        const seed = `seed-${seedIndex}`;
        const baseline = await captureFinalHtml(browser, testCase, seed, "microtask");
        console.log(`[scheduler-parity] ${testCase.fixture}/${testCase.scenario} seed=${seed} mode=microtask ok`);
        for (const mode of MODES) {
          if (mode === "microtask") continue;
          const candidate = await captureFinalHtml(browser, testCase, seed, mode);
          await assertHtmlParity(testCase, seed, "microtask", mode, baseline, candidate);
          console.log(`[scheduler-parity] ${testCase.fixture}/${testCase.scenario} seed=${seed} mode=${mode} ok`);
        }
      }
    }
    console.log("[scheduler-parity] PASS");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
