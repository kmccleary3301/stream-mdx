import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { build } from "esbuild";
import type { StreamingDemoAutomationApiV2 } from "../../apps/docs/components/screens/streaming-markdown-demo-v2/automation-api";
import type { PerfWindow } from "./demo-worker-lifecycle-browser";

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

function isDemoSourceEof(options: {
  mode: "worker" | "classic";
  workerId: number | null;
  generation: number | null;
}): boolean {
  const api: StreamingDemoAutomationApiV2 | undefined = window.__STREAMING_DEMO__;
  const state = api?.getState?.();
  if (
    !state ||
    state.finished !== true ||
    state.timerActive !== false ||
    state.streamError !== null ||
    state.idx !== state.total ||
    state.fullTextLength !== state.total ||
    state.streamLimit !== null ||
    state.workerSentIdx !== state.total
  ) {
    return false;
  }

  if (options.mode === "worker") {
    if (options.workerId === null || options.generation === null) return false;
    const observer = (window as PerfWindow).__STREAM_MDX_WORKER_LIFECYCLE__;
    if (!observer || observer.workerIdFor(api?.getWorker?.() ?? null) !== options.workerId) return false;
    const initSent = observer.events.find(
      (event) =>
        event.workerId === options.workerId &&
        event.generation === options.generation &&
        event.direction === "input" &&
        event.type === "INIT",
    );
    return Boolean(
      initSent &&
        observer.events.some(
          (event) =>
            event.sequence > initSent.sequence &&
            event.workerId === options.workerId &&
            event.generation === options.generation &&
            event.direction === "output" &&
            event.type === "INITIALIZED",
        ),
    );
  }
  return true;
}

function isDemoRunComplete(options: {
  mode: "worker" | "classic";
  workerId: number | null;
  generation: number | null;
  requireQueueDrain: boolean;
}): boolean {
  const api: StreamingDemoAutomationApiV2 | undefined = window.__STREAMING_DEMO__;
  const state = api?.getState?.();
  if (
    !state ||
    state.finished !== true ||
    state.timerActive !== false ||
    state.isFinalizing !== false ||
    state.isHostComplete !== true ||
    state.streamError !== null ||
    state.idx !== state.total ||
    state.fullTextLength !== state.total ||
    state.streamLimit !== null ||
    state.workerSentIdx !== state.total
  ) {
    return false;
  }

  if (options.mode === "worker") {
    if (
      state.nativeAdmissionGeneration === null ||
      state.nativeFinalizedGeneration !== state.nativeAdmissionGeneration ||
      options.workerId === null ||
      options.generation === null
    ) {
      return false;
    }
    const observer = (window as PerfWindow).__STREAM_MDX_WORKER_LIFECYCLE__;
    if (!observer || observer.workerIdFor(api?.getWorker?.() ?? null) !== options.workerId) {
      return false;
    }
    const initSent = observer.events.find(
      (event) =>
        event.workerId === options.workerId &&
        event.generation === options.generation &&
        event.direction === "input" &&
        event.type === "INIT",
    );
    if (!initSent) return false;
    const initialized = observer.events.find(
      (event) =>
        event.sequence > initSent.sequence &&
        event.workerId === options.workerId &&
        event.generation === options.generation &&
        event.direction === "output" &&
        event.type === "INITIALIZED",
    );
    if (!initialized) return false;
    const finalizeSent = observer.events.find(
      (event) =>
        event.sequence > initialized.sequence &&
        event.workerId === options.workerId &&
        event.generation === options.generation &&
        event.direction === "input" &&
        event.type === "FINALIZE",
    );
    if (!finalizeSent) return false;
    const finalized = observer.events.some(
      (event) =>
        event.sequence > finalizeSent.sequence &&
        event.workerId === options.workerId &&
        event.generation === options.generation &&
        event.direction === "output" &&
        event.type === "FINALIZED",
    );
    if (!finalized) return false;
  }

  if (options.requireQueueDrain) {
    const rendererState = api?.getHandle?.()?.getState?.();
    if (!rendererState || rendererState.queueDepth !== 0 || rendererState.pendingBatches !== 0) {
      return false;
    }
  }

  return true;
}

async function waitForRendererIdle(page: Page, timeoutMs: number): Promise<void> {
  await page.evaluate(async (timeoutMs) => {
    const api = window.__STREAMING_DEMO__;
    if (!api) throw new Error("window.__STREAMING_DEMO__ is unavailable while waiting for idle");
    if (typeof api.waitForIdle !== "function") {
      throw new Error("[waitForIdle] Demo API does not expose the renderer idle wait.");
    }

    const timeout = Promise.withResolvers<never>();
    const timer = window.setTimeout(
      () => timeout.reject(new Error(`[waitForIdle] Queue did not drain within ${timeoutMs}ms.`)),
      timeoutMs,
    );
    try {
      await Promise.race([api.waitForIdle(), timeout.promise]);
    } finally {
      window.clearTimeout(timer);
    }
  }, timeoutMs);
}


async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}
async function writePerfFailureArtifacts(
  pageId: number,
  error: unknown,
  capturedLogs: Array<{ type: string; message: string; timestamp: string }>,
  partialState?: unknown,
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const failurePath = path.join(OUT_DIR, `demo-perf-failure-${pageId}-${stamp}.json`);
  const payload = {
    run: pageId,
    timestamp: new Date().toISOString(),
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    partialState: partialState ?? null,
    capturedLogs,
  };
  await fs.writeFile(failurePath, JSON.stringify(payload, null, 2));
  return failurePath;
}

function attachPerfPageObservers(
  page: Page,
  capturedLogs: Array<{ type: string; message: string; timestamp: string }>,
): void {
  const pushLog = (type: string, message: string) => {
    capturedLogs.push({ type, message, timestamp: new Date().toISOString() });
    if (capturedLogs.length > 200) capturedLogs.shift();
  };

  page.on("pageerror", (error) => {
    const msg = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
    pushLog("pageerror", msg);
    console.error(`\n[perf pageerror] ${msg}`);
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure();
    const msg = `${request.method()} ${request.url()} - ${failure?.errorText ?? "request failed"}`;
    pushLog("requestfailed", msg);
    console.error(`\n[perf requestfailed] ${msg}`);
  });
  page.on("console", (message) => {
    const type = message.type();
    const text = message.text();
    if (type === "error") {
      pushLog("console.error", text);
      console.error(`\n[perf console.${type}] ${text}`);
    } else if (type === "warning") {
      pushLog("console.warn", text);
    }
  });
  page.on("worker", (worker) => {
    pushLog("worker.created", worker.url());
    worker.on("close", () => {
      pushLog("worker.closed", worker.url());
    });
  });
}

async function runOnce(pageId: number, page: Page, workerLifecycleScript: string) {
  const capturedLogs: Array<{ type: string; message: string; timestamp: string }> = [];
  attachPerfPageObservers(page, capturedLogs);

  const deadline = Date.now() + TIMEOUT_MS;
  const remainingTimeout = () => {
    const rem = deadline - Date.now();
    if (rem <= 0) {
      throw new Error(`Perf run ${pageId} exceeded configured deadline of ${TIMEOUT_MS}ms`);
    }
    return rem;
  };

  let partialState: unknown = null;
  try {
    if (MODE === "worker") {
      await page.addInitScript({ content: workerLifecycleScript });
    }

    await page.goto(`${BASE_URL}/demo`, { waitUntil: "domcontentloaded", timeout: remainingTimeout() });
    await page.waitForFunction(
      () => Boolean(window.__STREAMING_DEMO__),
      undefined,
      { timeout: remainingTimeout() },
    );

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
      } catch (error) {
        console.warn("[perf] long-task observation is unavailable; this run will omit long-task samples.", error);
      }
    });

    const restartBoundary = await page.evaluate(
      async ({ rate, tick, mode, schedulingPreset, timeoutMs }) => {
        const api = window.__STREAMING_DEMO__;
        if (!api) {
          throw new Error("window.__STREAMING_DEMO__ is unavailable during configuration");
        }
        if (mode === "worker" && api.waitForWorker) {
          const timeout = Promise.withResolvers<never>();
          const timer = window.setTimeout(
            () => timeout.reject(new Error(`[waitForWorker] Worker did not initialize within ${timeoutMs}ms.`)),
            timeoutMs,
          );
          try {
            await Promise.race([api.waitForWorker(), timeout.promise]);
          } finally {
            window.clearTimeout(timer);
          }
        }
        if (api.setSchedulingPreset) {
          api.setSchedulingPreset(schedulingPreset);
        }
        api.setMode?.(mode);
        api.setRate?.(rate);
        api.setTick?.(tick);
        const root = window as PerfWindow;
        const observer = root.__STREAM_MDX_WORKER_LIFECYCLE__;
        const boundary = observer?.sequence ?? 0;
        api.restart?.();
        if (mode === "worker") {
          const worker = api.getWorker?.() ?? null;
          if (!observer || !worker) {
            throw new Error("Could not observe the restarted demo worker.");
          }
          observer.watch(worker);
        }
        api.resume?.();
        return boundary;
      },
      { rate: RATE, tick: TICK, mode: MODE, schedulingPreset: SCHEDULING_PRESET, timeoutMs: remainingTimeout() },
    );

    let workerRun: { workerId: number; generation: number } | null = null;
    if (MODE === "worker") {
      await page.waitForFunction(
        (afterSequence) => {
          const api = window.__STREAMING_DEMO__;
          const observer = (window as PerfWindow).__STREAM_MDX_WORKER_LIFECYCLE__;
          if (!api || !observer) return false;
          const workerId = observer.workerIdFor(api.getWorker?.() ?? null);
          return (
            workerId !== null &&
            observer.events.some(
              (event) =>
                event.sequence > afterSequence &&
                event.workerId === workerId &&
                event.direction === "input" &&
                event.type === "INIT" &&
                event.generation !== null,
            )
          );
        },
        restartBoundary,
        { timeout: remainingTimeout() },
      );
      workerRun = await page.evaluate((afterSequence) => {
        const api = window.__STREAMING_DEMO__;
        const observer = (window as PerfWindow).__STREAM_MDX_WORKER_LIFECYCLE__;
        if (!api || !observer) return null;
        const workerId = observer.workerIdFor(api.getWorker?.() ?? null);
        if (workerId === null) return null;
        const init = observer.events.find(
          (event) =>
            event.sequence > afterSequence &&
            event.workerId === workerId &&
            event.direction === "input" &&
            event.type === "INIT" &&
            event.generation !== null,
        );
        return init?.generation === null || !init ? null : { workerId, generation: init.generation };
      }, restartBoundary);
      if (!workerRun) {
        throw new Error("Could not identify the restarted demo worker INIT generation.");
      }
    }

    const completionOptions = {
      mode: MODE,
      workerId: workerRun?.workerId ?? null,
      generation: workerRun?.generation ?? null,
      requireQueueDrain: false,
    };
    await page.waitForFunction(isDemoSourceEof, {
      mode: MODE,
      workerId: workerRun?.workerId ?? null,
      generation: workerRun?.generation ?? null,
    }, { timeout: remainingTimeout() });
    const finalizeResult = await page.evaluate(async ({ timeoutMs, mode }) => {
      const api = window.__STREAMING_DEMO__;
      if (!api || typeof api.finalize !== "function") {
        throw new Error("Streaming demo does not expose its host finalization barrier.");
      }
      const timeout = Promise.withResolvers<never>();
      const timer = window.setTimeout(
        () => timeout.reject(new Error(`Host finalization did not resolve within ${timeoutMs}ms.`)),
        timeoutMs,
      );
      try {
        const result = await Promise.race([api.finalize(), timeout.promise]);
        const state = api.getState?.();
        if (
          !state ||
          !Number.isSafeInteger(result.generation) ||
          result.generation < 0 ||
          state.streamError !== null ||
          state.isFinalizing !== false ||
          state.isHostComplete !== true ||
          state.idx !== state.total ||
          state.total !== state.fullTextLength ||
          state.streamLimit !== null ||
          state.workerSentIdx !== state.total ||
          result.acceptedSourceUnits !== state.total ||
          result.committedSourceUnits !== result.acceptedSourceUnits
        ) {
          throw new Error("Host finalization result did not cover the complete demo source.");
        }
        if (
          mode === "worker" &&
          (state.nativeAdmissionGeneration !== result.generation ||
            state.nativeFinalizedGeneration !== result.generation)
        ) {
          throw new Error(
            "Host finalization generation did not match both observed native admission/finalization headers.",
          );
        }
        return result;
      } finally {
        if (timer !== undefined) window.clearTimeout(timer);
      }
    }, { timeoutMs: Math.min(30_000, remainingTimeout()), mode: MODE });
    await page.waitForFunction(isDemoRunComplete, completionOptions, { timeout: remainingTimeout() });
    await waitForRendererIdle(page, remainingTimeout());
    await page.waitForFunction(
      isDemoRunComplete,
      { ...completionOptions, requireQueueDrain: true },
      { timeout: remainingTimeout() },
    );

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
      hostFinalization: finalizeResult,
      baseUrl: BASE_URL,
      ...result,
    };
  } catch (error) {
    try {
      partialState = await page.evaluate(() => {
        const api = window.__STREAMING_DEMO__;
        const observer = (window as PerfWindow).__STREAM_MDX_WORKER_LIFECYCLE__;
        const rendererState = api?.getHandle?.()?.getState?.();
        return {
          state: api?.getState?.() ?? null,
          perf: api?.getPerf?.() ?? null,
          workerLifecycle: {
            currentWorkerId: observer?.workerIdFor(api?.getWorker?.() ?? null) ?? null,
            events: observer?.events ?? null,
          },
          renderer: {
            queueDepth: rendererState?.queueDepth ?? null,
            pendingBatches: rendererState?.pendingBatches ?? null,
          },
        };
      });
    } catch (captureError) {
      partialState = {
        captureError: captureError instanceof Error ? captureError.message : String(captureError),
      };
    }
    const failurePath = await writePerfFailureArtifacts(pageId, error, capturedLogs, partialState);
    console.error(`\n[perf error] run ${pageId} failed:`, error);
    console.error(`artifacts: ${failurePath}`);
    throw error;
  }
}

async function run(): Promise<void> {
  if (!Number.isFinite(RATE) || RATE <= 0) throw new Error("Invalid rate.");
  if (!Number.isFinite(TICK) || TICK <= 0) throw new Error("Invalid tick interval.");
  if (!Number.isFinite(RUNS) || RUNS <= 0) throw new Error("Invalid runs.");

  await ensureDir(OUT_DIR);

  const workerLifecycleScript =
    MODE === "worker"
      ? (
          await build({
            entryPoints: [fileURLToPath(new URL("./demo-worker-lifecycle-browser.ts", import.meta.url))],
            platform: "browser",
            bundle: true,
            write: false,
            format: "iife",
            keepNames: false,
            target: "es2020",
          })
        ).outputFiles[0].text
      : "";

  const browser = await chromium.launch();
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext();
    const outputs: unknown[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      const page = await context.newPage();
      try {
        const result = await runOnce(i + 1, page, workerLifecycleScript);
        outputs.push(result);
      } finally {
        await page.close().catch((error) => {
          console.error(`Failed to close perf page ${i + 1}:`, error);
        });
      }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = path.join(OUT_DIR, `demo-perf-${stamp}.json`);
    await fs.writeFile(outPath, JSON.stringify(outputs, null, 2));
    console.log(`perf baseline saved: ${outPath}`);
  } finally {
    await context?.close().catch((error) => {
      console.error("Failed to close perf browser context:", error);
      process.exitCode = 1;
    });
    await browser.close().catch((error) => {
      console.error("Failed to close perf browser:", error);
      process.exitCode = 1;
    });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
