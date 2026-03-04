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
  await page.goto(url, { waitUntil: "commit", timeout: 90_000 });

  const hasAutomation = await page
    .waitForFunction(() => Boolean((window as any).__STREAMING_DEMO__), { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  if (hasAutomation) {
    const summary = await page.evaluate(async ({ runIterations }) => {
      const api = (window as any).__STREAMING_DEMO__;
      await api.waitForWorker();
      api.setRate(20_000);
      api.setTick(1);

      for (let i = 0; i < runIterations; i += 1) {
        api.restart();
        if (i % 3 === 0) {
          api.restart();
        }
        await api.waitForWorker();
        api.resume();
        await new Promise((resolve) => setTimeout(resolve, 12));
        if (i % 2 === 0) {
          await api.fastForward();
        }
        api.finalize();
        await api.flushPending();
        await api.waitForIdle();
      }

      const state = api.getState();
      const textLength = (document.querySelector(".markdown-v2-output")?.textContent ?? "").length;
      return {
        mode: "automation",
        state,
        textLength,
      };
    }, { runIterations: iterations });

    const textLength = Number((summary as { textLength?: number }).textLength ?? 0);
    if (textLength < 80) {
      throw new Error(`demo surface rendered too little content after restart race (${textLength} chars)`);
    }
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

  return summary as Record<string, unknown>;
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
