import path from "node:path";
import fs from "node:fs/promises";

import { chromium } from "@playwright/test";

const BASE_URL = process.env.STREAM_MDX_PERF_BASE_URL ?? "http://localhost:3000";

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function getNumArg(flag: string): number | null {
  const value = getArg(flag);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const RATE = getNumArg("--rate") ?? Number(process.env.STREAM_MDX_PERF_RATE ?? 12000);
const TICK = getNumArg("--tick") ?? Number(process.env.STREAM_MDX_PERF_TICK ?? 5);
const RUNS = getNumArg("--runs") ?? Number(process.env.STREAM_MDX_PERF_RUNS ?? 1);
const MODE = (getArg("--mode") ?? process.env.STREAM_MDX_PERF_MODE ?? "worker") as "worker" | "classic";
const OUT_DIR = getArg("--out") ?? process.env.STREAM_MDX_PERF_OUT ?? "tmp/perf-baseline";
const TIMEOUT_MS = getNumArg("--timeout") ?? Number(process.env.STREAM_MDX_PERF_TIMEOUT ?? 180000);
const PATCH_PERF_FLAG = getArg("--patch-perf") ?? process.env.STREAM_MDX_PERF_PATCH_PERF ?? "0";
const PATCH_PERF_ENABLED = PATCH_PERF_FLAG === "1" || PATCH_PERF_FLAG === "true";
const SCHEDULING_PRESET = (getArg("--scheduling") ?? process.env.STREAM_MDX_PERF_SCHEDULING_PRESET ?? "latency") as
  | "latency"
  | "throughput";

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function runOnce(pageId: number, page: Awaited<ReturnType<ReturnType<typeof chromium.launch>["newPage"]>>) {
  await page.goto(`${BASE_URL}/demo`, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
  await page.waitForFunction(() => Boolean(window.__STREAMING_DEMO__));

  if (PATCH_PERF_ENABLED) {
    await page.evaluate(() => {
      const root = window as typeof window & { __STREAMING_DEBUG__?: { patchPerf?: boolean } };
      root.__STREAMING_DEBUG__ = { ...(root.__STREAMING_DEBUG__ ?? {}), patchPerf: true };
    });
  }

  const apiAvailable = await page.evaluate(() => Boolean(window.__STREAMING_DEMO__));
  if (!apiAvailable) {
    throw new Error(
      "Streaming demo API is not available. Start the dev server with NEXT_PUBLIC_STREAMING_DEMO_API=true.",
    );
  }

  await page.evaluate(() => {
    const win = window as typeof window & {
      __STREAM_MDX_LONGTASKS__?: Array<{ startTime: number; duration: number }>;
      __STREAM_MDX_LONGTASK_OBSERVER__?: PerformanceObserver;
    };
    if (!win.__STREAM_MDX_LONGTASKS__) {
      win.__STREAM_MDX_LONGTASKS__ = [];
    }
    if (!("PerformanceObserver" in window)) return;
    try {
      if (win.__STREAM_MDX_LONGTASK_OBSERVER__) return;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          win.__STREAM_MDX_LONGTASKS__?.push({
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
      });
      observer.observe({ type: "longtask", buffered: true });
      win.__STREAM_MDX_LONGTASK_OBSERVER__ = observer;
    } catch {
      // ignore observer errors
    }
  });

  await page.evaluate(
    async ({ rate, tick, mode, schedulingPreset }) => {
      const api = window.__STREAMING_DEMO__;
      if (!api) return;
      if (api.waitForWorker) {
        await api.waitForWorker();
      }
      if (api.setSchedulingPreset) {
        api.setSchedulingPreset(schedulingPreset);
      }
      api.setMode?.(mode);
      api.setRate?.(rate);
      api.setTick?.(tick);
      api.restart?.();
      api.resume?.();
    },
    { rate: RATE, tick: TICK, mode: MODE, schedulingPreset: SCHEDULING_PRESET },
  );

  await page.waitForFunction(
    () => {
      const state = window.__STREAMING_DEMO__?.getState?.();
      if (!state) return false;
      return Boolean(state.finished) || (typeof state.idx === "number" && typeof state.total === "number" && state.idx >= state.total);
    },
    { timeout: TIMEOUT_MS },
  );

  await page.evaluate(async () => {
    if (window.__STREAMING_DEMO__?.waitForIdle) {
      await window.__STREAMING_DEMO__.waitForIdle();
    }
  });

  const result = await page.evaluate(() => {
    const api = window.__STREAMING_DEMO__;
    const longTasks = (window as typeof window & {
      __STREAM_MDX_LONGTASKS__?: Array<{ startTime: number; duration: number }>;
    }).__STREAM_MDX_LONGTASKS__ ?? [];
    const patchPerfTotals = (window as typeof window & {
      __STREAM_MDX_PATCH_STATS_TOTALS__?: unknown;
    }).__STREAM_MDX_PATCH_STATS_TOTALS__ ?? null;
    const patchPerfLast = (window as typeof window & {
      __STREAM_MDX_PATCH_STATS_LAST__?: unknown;
    }).__STREAM_MDX_PATCH_STATS_LAST__ ?? null;
    const durations = longTasks.map((entry) => entry.duration).sort((a, b) => a - b);
    const totalDuration = durations.reduce((sum, value) => sum + value, 0);
    const p95Index = durations.length > 0 ? Math.min(durations.length - 1, Math.floor(durations.length * 0.95)) : 0;
    const p95 = durations.length > 0 ? durations[p95Index] : 0;
    return {
      state: api?.getState?.() ?? null,
      perf: api?.getPerf?.() ?? null,
      patchPerf: {
        totals: patchPerfTotals,
        last: patchPerfLast,
      },
      longTasks: {
        count: durations.length,
        totalDuration,
        max: durations.length > 0 ? durations[durations.length - 1] : 0,
        p95,
      },
      userAgent: navigator.userAgent,
      timestamp: new Date().toISOString(),
    };
  });

  return {
    run: pageId,
    rate: RATE,
    tickMs: TICK,
    mode: MODE,
    baseUrl: BASE_URL,
    ...result,
  };
}

async function run(): Promise<void> {
  if (!Number.isFinite(RATE) || RATE <= 0) throw new Error("Invalid rate.");
  if (!Number.isFinite(TICK) || TICK <= 0) throw new Error("Invalid tick interval.");
  if (!Number.isFinite(RUNS) || RUNS <= 0) throw new Error("Invalid runs.");

  await ensureDir(OUT_DIR);

  const browser = await chromium.launch();
  const context = await browser.newContext();

  const outputs: unknown[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const page = await context.newPage();
    const result = await runOnce(i + 1, page);
    outputs.push(result);
    await page.close();
  }

  await context.close();
  await browser.close();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(OUT_DIR, `demo-perf-${stamp}.json`);
  await fs.writeFile(outPath, JSON.stringify(outputs, null, 2));
  console.log(`perf baseline saved: ${outPath}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
