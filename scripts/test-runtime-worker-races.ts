import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { StreamingDemoAutomationApiV2 } from "../apps/docs/components/screens/streaming-markdown-demo-v2/automation-api";
import type { PerfWindow } from "./perf/demo-worker-lifecycle-browser";
import { chromium, type ConsoleMessage, type Page } from "playwright";

type Args = {
  baseUrl: string;
  regressionIterations: number;
  demoIterations: number;
  benchmarkIterations: number;
};

type SurfaceResult = {
  surface: "regression" | "demo" | "benchmarks";
  summary: Record<string, unknown>;
  badLogs: string[];
  pageErrors: string[];
};

const BAD_PATTERNS = [
  /worker not attached/i,
  /failed to create markdown worker instance/i,
  /fastforward append failed/i,
  /maximum update depth/i,
  /did not initialize within the expected window/i,
  /renderer .* failed/i,
  /v2 markdown worker reported an error/i,
];

function parseArgs(argv: string[]): Args {
  const out: Args = {
    baseUrl: "http://localhost:3000",
    regressionIterations: 16,
    demoIterations: 20,
    benchmarkIterations: 24,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--base-url" && args[i + 1]) {
      out.baseUrl = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--regression-iterations" && args[i + 1]) {
      out.regressionIterations = Number.parseInt(args[i + 1], 10);
      i += 1;
      continue;
    }
    if (arg === "--demo-iterations" && args[i + 1]) {
      out.demoIterations = Number.parseInt(args[i + 1], 10);
      i += 1;
      continue;
    }
    if (arg === "--benchmark-iterations" && args[i + 1]) {
      out.benchmarkIterations = Number.parseInt(args[i + 1], 10);
      i += 1;
      continue;
    }
  }
  return out;
}

function normalizeUrl(baseUrl: string, pathname: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base}${path}`;
}

function toLogText(message: ConsoleMessage): string {
  const location = message.location();
  const source = location.url ? `${location.url}:${location.lineNumber ?? 0}` : "";
  return `[${message.type()}] ${source} ${message.text()}`.trim();
}

function findBadLogs(logs: string[]): string[] {
  return logs.filter((entry) => BAD_PATTERNS.some((pattern) => pattern.test(entry)));
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (true) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function runRegressionSurface(page: Page, url: string, iterations: number): Promise<Record<string, unknown>> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForFunction(() => Boolean((window as any).__streammdxRegression), { timeout: 15_000 });

  const summary = await page.evaluate(async ({ runIterations }) => {
    const api = (window as any).__streammdxRegression;
    const sample = [
      "1. Race cycle",
      "2. Restart path",
      "",
      "- nested",
      "  - branch",
      "",
      "Footnote reference[^race].",
      "",
      "[^race]: Runtime race validation.",
      "",
    ].join("\n");

    await api.waitForReady();

    for (let i = 0; i < runIterations; i += 1) {
      api.restart();
      if (i % 4 === 0) {
        api.restart();
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      await api.waitForReady();
      await api.appendAndFlush(`${sample}\nCycle ${i}.\n`);
      if (i % 2 === 0) {
        await api.finalizeAndFlush();
      }
    }

    api.restart();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await api.waitForReady();
    await api.appendAndFlush(`${sample}\nFinal anchor cycle.\n`);
    await api.finalizeAndFlush();

    const invariants = api.getInvariantViolations();
    const surfaceSummary = api.getSummary();
    const textLength = (document.querySelector("#regression-root")?.textContent ?? "").length;

    return {
      invariants,
      summary: surfaceSummary,
      textLength,
    };
  }, { runIterations: iterations });

  const invariantMessages = Array.isArray((summary as { invariants?: Array<{ message?: string }> }).invariants)
    ? ((summary as { invariants: Array<{ message?: string }> }).invariants ?? []).map((item) => item.message ?? "")
    : [];

  if (invariantMessages.length > 0) {
    throw new Error(`regression surface invariants failed: ${invariantMessages.join(" | ")}`);
  }
  const textLength = Number((summary as { textLength?: number }).textLength ?? 0);
  if (textLength < 80) {
    throw new Error(`regression surface rendered too little content after restart race (${textLength} chars)`);
  }

  return summary as Record<string, unknown>;
}

async function runDemoSurface(page: Page, url: string, iterations: number): Promise<Record<string, unknown>> {
  const lifecycleBundle = await build({
    entryPoints: [fileURLToPath(new URL("./perf/demo-worker-lifecycle-browser.ts", import.meta.url))],
    platform: "browser",
    bundle: true,
    write: false,
    target: "es2020",
  });
  const lifecycleScript = lifecycleBundle.outputFiles[0]?.text;
  if (!lifecycleScript) throw new Error("Could not bundle the worker lifecycle observer.");
  await page.addInitScript({ content: lifecycleScript });
  await page.goto(url, { waitUntil: "commit", timeout: 90_000 });

  let automationFallbackReason: string | null = null;
  const hasAutomation = await page
    .waitForFunction(() => Boolean((window as any).__STREAMING_DEMO__), { timeout: 10_000 })
    .then(() => true)
    .catch((error) => {
      automationFallbackReason = error instanceof Error ? error.message : String(error);
      return false;
    });

  if (hasAutomation) {
    const summary = await page.evaluate(async ({ runIterations }) => {
      const root = window as Window & {
        __STREAMING_DEMO__?: StreamingDemoAutomationApiV2;
      };
      const api = root.__STREAMING_DEMO__;
      const observer = (root as PerfWindow).__STREAM_MDX_WORKER_LIFECYCLE__;
      if (!api || !observer) throw new Error("Demo automation or worker lifecycle observer is unavailable.");

      // Native methods survive Playwright serialization without Node-side naming helpers.
      const completion = {
        async within<T>(promise: Promise<T>, label: string): Promise<T> {
          const { promise: timeoutPromise, reject } = Promise.withResolvers<T>();
          const timer = window.setTimeout(
            () => reject(new Error(`${label} timed out after 10,000ms.`)),
            10_000,
          );
          try {
            return await Promise.race([promise, timeoutPromise]);
          } finally {
            window.clearTimeout(timer);
          }
        },
        delay(milliseconds: number): Promise<void> {
          const { promise, resolve } = Promise.withResolvers<void>();
          window.setTimeout(resolve, milliseconds);
          return promise;
        },
        async worker(label: string): Promise<void> {
          if (!api.waitForWorker) throw new Error("Demo automation does not expose worker readiness.");
          await this.within(api.waitForWorker(), label);
        },
        async event<T>(readEvent: () => T | null, label: string): Promise<T> {
          const startedAt = Date.now();
          while (true) {
            const event = readEvent();
            if (event !== null) return event;
            if (Date.now() - startedAt > 10_000) throw new Error(`${label} timed out after 10,000ms.`);
            await this.delay(20);
          }
        },
      };

      await completion.worker("Initial demo worker readiness");
      api.setRate(20_000);
      api.setTick(1);

      let lastAcceptedSourceUnits: number | null = null;
      for (let i = 0; i < runIterations; i += 1) {
        const afterSequence = observer.sequence;
        api.restart();
        if (i % 3 === 0) api.restart();
        await completion.worker(`Demo worker readiness in iteration ${i}`);
        const worker = api.getWorker?.() ?? null;
        observer.watch(worker);
        const workerId = observer.workerIdFor(worker);
        if (workerId === null) throw new Error(`Demo worker was unavailable in iteration ${i}.`);
        const initSent = await completion.event(
          () => {
            const events = observer.events.filter(
              (event) =>
                event.sequence > afterSequence &&
                event.workerId === workerId &&
                event.direction === "input" &&
                event.type === "INIT",
            );
            return events[events.length - 1] ?? null;
          },
          `Worker INIT in iteration ${i}`,
        );
        await completion.event(
          () =>
            observer.events.find(
              (event) =>
                event.sequence > initSent.sequence &&
                event.workerId === workerId &&
                event.generation === initSent.generation &&
                event.direction === "output" &&
                event.type === "INITIALIZED",
            ) ?? null,
          `Worker INITIALIZED in iteration ${i}`,
        );
        api.resume();
        await completion.delay(12);
        if (i % 2 === 0) {
          if (!api.fastForward) throw new Error("Demo automation does not expose fast-forward.");
          await completion.within(Promise.resolve(api.fastForward()), `Demo fast-forward in iteration ${i}`);
          const offered = api.getState();
          if (offered.idx !== offered.fullTextLength || offered.workerSentIdx !== offered.idx) {
            throw new Error(`Fast-forward did not publish its offered/admitted source frontier: ${JSON.stringify({
              idx: offered.idx,
              fullTextLength: offered.fullTextLength,
              workerSentIdx: offered.workerSentIdx,
            })}`);
          }
        }
        const finalizeBoundary = observer.sequence;
        if (!api.finalize) throw new Error("Demo automation does not expose host finalization.");
        const result = await completion.within(api.finalize(), `Host finalization in iteration ${i}`);
        lastAcceptedSourceUnits = result.acceptedSourceUnits;
        const finalizeSent = await completion.event(
          () =>
            observer.events.find(
              (event) =>
                event.sequence > finalizeBoundary &&
                event.workerId === workerId &&
                event.generation === initSent.generation &&
                event.direction === "input" &&
                event.type === "FINALIZE",
            ) ?? null,
          `Worker FINALIZE in iteration ${i}`,
        );
        await completion.event(
          () =>
            observer.events.find(
              (event) =>
                event.sequence > finalizeSent.sequence &&
                event.workerId === workerId &&
                event.generation === initSent.generation &&
                event.direction === "output" &&
                event.type === "FINALIZED",
            ) ?? null,
          `Worker FINALIZED in iteration ${i}`,
        );
        const state = api.getState();
        if (
          !Number.isSafeInteger(result.generation) ||
          result.generation < 0 ||
          (result.acceptedSourceUnits > 0 && result.generation !== state.nativeAdmissionGeneration) ||
          result.generation !== state.nativeFinalizedGeneration ||
          result.acceptedSourceUnits !== state.workerSentIdx ||
          result.committedSourceUnits !== result.acceptedSourceUnits ||
          state.isHostComplete !== true ||
          state.isFinalizing !== false ||
          state.streamError !== null
        ) {
          throw new Error(`Host finalization status/counts did not match native worker evidence in iteration ${i}: ${JSON.stringify({
            result,
            nativeAdmissionGeneration: state.nativeAdmissionGeneration,
            nativeFinalizedGeneration: state.nativeFinalizedGeneration,
            workerSentIdx: state.workerSentIdx,
            isHostComplete: state.isHostComplete,
            isFinalizing: state.isFinalizing,
            streamError: state.streamError,
          })}`);
        }
        await completion.within(Promise.resolve(api.flushPending()), `Renderer flush in iteration ${i}`);
        await completion.within(Promise.resolve(api.waitForIdle()), `Renderer idle in iteration ${i}`);
      }

      if (lastAcceptedSourceUnits === 0) {
        await completion.event(
          () => document.querySelector(".markdown-v2-output")?.textContent === "" ? true : null,
          "Empty finalized generation must not retain the prior rendered document",
        );
      }
      const finalTextLength = (document.querySelector(".markdown-v2-output")?.textContent ?? "").length;
      const state = api.getState();
      return {
        mode: "automation",
        state,
        nativeAdmissionGeneration: state.nativeAdmissionGeneration,
        nativeFinalizedGeneration: state.nativeFinalizedGeneration,
        textLength: finalTextLength,
      };
    }, { runIterations: iterations });

    return summary as Record<string, unknown>;
  }

  await page.waitForSelector('button:has-text("Restart")', { timeout: 15_000 });
  await page.waitForSelector(".markdown-v2-output", { timeout: 15_000 });
  const summary = await page.evaluate(async ({ runIterations }) => {
    const restartButton = Array.from(document.querySelectorAll("button")).find(
      (button) => (button.textContent ?? "").trim() === "Restart",
    ) as HTMLButtonElement | undefined;
    if (!restartButton) {
      throw new Error("demo restart button not found");
    }

    {
      const toggle = Array.from(document.querySelectorAll("button")).find((button) => {
        const text = (button.textContent ?? "").trim();
        return text === "Pause" || text === "Resume";
      }) as HTMLButtonElement | undefined;
      if (toggle && (toggle.textContent ?? "").trim() === "Resume") {
        toggle.click();
      }
    }

    for (let i = 0; i < runIterations; i += 1) {
      restartButton.click();
      if (i % 5 === 0) {
        restartButton.click();
      }
      {
        const toggle = Array.from(document.querySelectorAll("button")).find((button) => {
          const text = (button.textContent ?? "").trim();
          return text === "Pause" || text === "Resume";
        }) as HTMLButtonElement | undefined;
        if (toggle && (toggle.textContent ?? "").trim() === "Resume") {
          toggle.click();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 14));
    }

    {
      const toggle = Array.from(document.querySelectorAll("button")).find((button) => {
        const text = (button.textContent ?? "").trim();
        return text === "Pause" || text === "Resume";
      }) as HTMLButtonElement | undefined;
      if (toggle && (toggle.textContent ?? "").trim() === "Resume") {
        toggle.click();
      }
    }

    const startedAt = Date.now();
    const timeoutMs = 7_000;
    while (true) {
      const textLength = (document.querySelector(".markdown-v2-output")?.textContent ?? "").length;
      if (textLength >= 80) {
        break;
      }
      if (Date.now() - startedAt > timeoutMs) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    const textLength = (document.querySelector(".markdown-v2-output")?.textContent ?? "").length;
    return {
      mode: "dom-fallback",
      textLength,
    };
  }, { runIterations: iterations });

  const textLength = Number((summary as { textLength?: number }).textLength ?? 0);
  if (textLength < 80) {
    throw new Error(`demo fallback surface rendered too little content after restart race (${textLength} chars)`);
  }

  return {
    ...(summary as Record<string, unknown>),
    automationFallbackReason,
  };
}

async function runBenchmarkSurface(page: Page, url: string, iterations: number): Promise<Record<string, unknown>> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });

  await page.waitForFunction(() => Boolean((window as any).__streamMdxBenchHandle), { timeout: 20_000 });

  const summary = await page.evaluate(async ({ runIterations }) => {
    {
      const timeoutMs = 10_000;
      const start = Date.now();
      while (true) {
        const handle = (window as any).__streamMdxBenchHandle;
        const state = handle?.getState?.();
        if (handle && state?.workerReady) break;
        if (Date.now() - start > timeoutMs) {
          throw new Error("benchmark handle worker readiness timed out");
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }

    for (let i = 0; i < runIterations; i += 1) {
      let handle: any = null;
      {
        const timeoutMs = 10_000;
        const start = Date.now();
        while (true) {
          const candidate = (window as any).__streamMdxBenchHandle;
          const state = candidate?.getState?.();
          if (candidate && state?.workerReady) {
            handle = candidate;
            break;
          }
          if (Date.now() - start > timeoutMs) {
            throw new Error("benchmark handle worker readiness timed out");
          }
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      }
      handle.restart();
      if (i % 4 === 0) {
        handle.restart();
      }

      await new Promise((resolve) => setTimeout(resolve, 25));

      {
        const timeoutMs = 10_000;
        const start = Date.now();
        while (true) {
          const candidate = (window as any).__streamMdxBenchHandle;
          const state = candidate?.getState?.();
          if (candidate && state?.workerReady) {
            candidate.flushPending?.();
            await candidate.waitForIdle?.();
            break;
          }
          if (Date.now() - start > timeoutMs) {
            throw new Error("benchmark handle worker readiness timed out");
          }
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      }
    }

    let finalHandle: any = null;
    {
      const timeoutMs = 10_000;
      const start = Date.now();
      while (true) {
        const candidate = (window as any).__streamMdxBenchHandle;
        const state = candidate?.getState?.();
        if (candidate && state?.workerReady) {
          finalHandle = candidate;
          break;
        }
        if (Date.now() - start > timeoutMs) {
          throw new Error("benchmark handle worker readiness timed out");
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }

    const finalState = finalHandle.getState();
    return {
      finalState: {
        workerReady: finalState.workerReady,
        queueDepth: finalState.queueDepth,
        pendingBatches: finalState.pendingBatches,
        blocks: finalState.blocks.length,
      },
      outputPanels: document.querySelectorAll(".markdown-v2-output").length,
    };
  }, { runIterations: iterations });

  const finalState = (summary as { finalState?: { workerReady?: boolean; pendingBatches?: number } }).finalState;
  const outputPanels = Number((summary as { outputPanels?: number }).outputPanels ?? 0);
  if (!finalState?.workerReady) {
    throw new Error("benchmark surface ended without workerReady=true");
  }
  if ((finalState.pendingBatches ?? 0) > 0) {
    throw new Error(`benchmark surface ended with pending batches (${finalState.pendingBatches})`);
  }
  if (outputPanels < 1) {
    throw new Error("benchmark surface did not render any stream-mdx output panels");
  }

  return summary as Record<string, unknown>;
}

async function runSurface(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  surface: SurfaceResult["surface"],
  url: string,
  runner: (page: Page) => Promise<Record<string, unknown>>,
): Promise<SurfaceResult> {
  const page = await browser.newPage();
  const consoleLogs: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (message) => {
    consoleLogs.push(toLogText(message));
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  try {
    const summary = await runner(page);
    const badLogs = findBadLogs(consoleLogs);
    return {
      surface,
      summary,
      badLogs,
      pageErrors,
    };
  } finally {
    await page.close();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const browser = await chromium.launch({ headless: true });

  try {
    const regressionUrl = normalizeUrl(args.baseUrl, "/regression/html/");
    const demoUrl = normalizeUrl(args.baseUrl, "/demo/");
    const benchmarksUrl = normalizeUrl(args.baseUrl, "/benchmarks/");

    const results: SurfaceResult[] = [];

    results.push(
      await runSurface(browser, "regression", regressionUrl, (page) => runRegressionSurface(page, regressionUrl, args.regressionIterations)),
    );
    results.push(await runSurface(browser, "demo", demoUrl, (page) => runDemoSurface(page, demoUrl, args.demoIterations)));
    results.push(
      await runSurface(browser, "benchmarks", benchmarksUrl, (page) => runBenchmarkSurface(page, benchmarksUrl, args.benchmarkIterations)),
    );

    const failures: string[] = [];
    for (const result of results) {
      if (result.pageErrors.length > 0) {
        failures.push(`${result.surface}: page errors -> ${result.pageErrors.join(" | ")}`);
      }
      if (result.badLogs.length > 0) {
        failures.push(`${result.surface}: bad logs -> ${result.badLogs.join(" | ")}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`worker attach/restart race checks failed:\n${failures.join("\n")}`);
    }

    process.stdout.write("[stream-mdx] worker attach/restart race checks passed\n");
    for (const result of results) {
      process.stdout.write(`[stream-mdx] ${result.surface} summary: ${JSON.stringify(result.summary)}\n`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
