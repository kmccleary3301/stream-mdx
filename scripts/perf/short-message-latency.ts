import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser } from "playwright";
import { build } from "tsup";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = path.join(REPO_ROOT, "scripts/perf/short-message-latency-fixture.ts");
const WORKER_PACKAGE = path.join(REPO_ROOT, "packages/markdown-v2-worker");
const WORKER_ENTRY = path.join(WORKER_PACKAGE, "src/worker.ts");
const RUNS_PER_ENGINE = 20;
const LATENCY_BUDGET_MS = 50;
const RUN_TIMEOUT_MS = 120_000;
const MESSAGE = `# Operations update: migration checkpoint

The handoff is moving on schedule, and the team has confirmed that the next review can begin as soon as the archive pass finishes. Each service keeps its own \`checkpoint.json\` so a delayed upload can be retried without rewriting the rest of the report.

For the current batch, the dashboard records a concise status in \`releaseState.current\`, while the audit trail preserves the original owner and timestamp. We have kept the notes short enough to scan quickly, but included the details needed to distinguish a normal pause from a blocked handoff.

- Verify the replica has caught up before opening the review window.
- Compare the manifest with the uploaded files, including the final checksum.
- Record any missing item in \`followUp.owner\` and assign one reviewer.`;

type Engine = "auto" | "worker";
type BrowserMeasurement = {
  firstContentMs: number;
  inlineDecorationReadyMs: number;
  firstText: string;
  workerStartupMs: number | null;
};

type PageResult = BrowserMeasurement & { engine: Engine };

function percentile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(fraction * ordered.length) - 1] ?? Number.NaN;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle] ?? Number.NaN;
  return ((ordered[middle - 1] ?? Number.NaN) + (ordered[middle] ?? Number.NaN)) / 2;
}

function formatMs(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  assert.ok(Buffer.byteLength(MESSAGE, "utf8") >= 600, "assistant-style fixture must be at least 600 bytes");
  assert.ok(Buffer.byteLength(MESSAGE, "utf8") <= 900, "assistant-style fixture must be at most 900 bytes");

  const outputDir = await mkdtemp(path.join(os.tmpdir(), "stream-mdx-short-message-"));
  const appDir = path.join(outputDir, "app");
  const workerDir = path.join(outputDir, "worker");
  let server: Server | null = null;
  let browser: Browser | null = null;

  try {
    await build({
      entry: { app: FIXTURE },
      outDir: appDir,
      format: "esm",
      splitting: true,
      platform: "browser",
      target: "chrome120",
      bundle: true,
      clean: false,
      dts: false,
      config: false,
      silent: true,
      minify: true,
      replaceNodeEnv: true,
      define: { __STREAM_MDX_COUNTERS__: "false" },
    });
    const appFiles = await readdir(appDir);
    const appBundle = appFiles.find((file) => /^app\.(?:mjs|js)$/.test(file));
    assert.ok(appBundle, "the production browser fixture should bundle for Chromium");

    const workerRequire = createRequire(path.join(WORKER_PACKAGE, "package.json"));
    const workerAliases = {
      "decode-named-character-reference": path.join(WORKER_PACKAGE, "src/entities/named-character-reference.ts"),
      "hast-util-from-html-isomorphic": workerRequire.resolve("hast-util-from-html-isomorphic"),
    };
    await build({
      entry: { "markdown-worker": WORKER_ENTRY },
      outDir: workerDir,
      format: "esm",
      splitting: false,
      platform: "browser",
      target: "es2020",
      bundle: true,
      clean: false,
      dts: false,
      config: false,
      silent: true,
      minify: false,
      minifySyntax: true,
      define: { __STREAM_MDX_COUNTERS__: "false" },
      noExternal: [/.*/],
      external: [],
      esbuildOptions(options) {
        options.alias = { ...(options.alias ?? {}), ...workerAliases };
      },
      outExtension() {
        return { js: ".js" };
      },
    });
    const workerBundle = path.join(workerDir, "markdown-worker.js");
    await access(workerBundle);

    const html = `<!doctype html><html><head><meta charset='utf-8'><title>Short message latency</title></head><body><div id='root'></div><script type='module' src='/${appBundle}'></script></body></html>`;
    server = createServer(async (request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(html);
        return;
      }
      if (requestUrl.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }

      const isWorker = requestUrl.pathname === "/workers/markdown-worker.js";
      const root = isWorker ? workerDir : appDir;
      const filePath = isWorker ? workerBundle : path.resolve(root, `.${decodeURIComponent(requestUrl.pathname)}`);
      if (!isWorker && !filePath.startsWith(`${root}${path.sep}`)) {
        response.writeHead(404);
        response.end();
        return;
      }
      try {
        await access(filePath);
      } catch {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      createReadStream(filePath).pipe(response);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string", "the benchmark server should bind a local TCP port");
    const origin = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const results: PageResult[] = [];
    const browserErrors: string[] = [];
    for (const engine of ["auto", "worker"] as const) {
      for (let run = 0; run < RUNS_PER_ENGINE; run += 1) {
        const page = await context.newPage();
        page.setDefaultNavigationTimeout(RUN_TIMEOUT_MS);
        page.on("console", (message) => {
          if (message.type() === "error") browserErrors.push(`${engine} run ${run + 1}: ${message.text()}`);
        });
        page.on("pageerror", (error) => browserErrors.push(`${engine} run ${run + 1}: ${String(error)}`));
        try {
          await page.goto(`${origin}/?engine=${engine}&message=${encodeURIComponent(MESSAGE)}`, {
            waitUntil: "load",
            timeout: RUN_TIMEOUT_MS,
          });
          const measurement = await withTimeout(
            page.evaluate(async () => {
              const result = (window as Window & { __SHORT_MESSAGE_RESULT__?: Promise<BrowserMeasurement> })
                .__SHORT_MESSAGE_RESULT__;
              if (!result) throw new Error("benchmark page did not publish its measurement promise");
              return result;
            }),
            RUN_TIMEOUT_MS,
            `${engine} run ${run + 1} did not produce first authored content`,
          );
          assert.ok(Number.isFinite(measurement.firstContentMs) && measurement.firstContentMs >= 0);
          assert.ok(Number.isFinite(measurement.inlineDecorationReadyMs) && measurement.inlineDecorationReadyMs >= measurement.firstContentMs);
          assert.ok(measurement.firstText.length > 0 && MESSAGE.includes(measurement.firstText));
          if (engine === "worker") assert.ok(Number.isFinite(measurement.workerStartupMs));
          else assert.equal(measurement.workerStartupMs, null);
          results.push({ engine, ...measurement });
        } finally {
          await page.close();
        }
      }
    }
    await context.close();
    if (browserErrors.length > 0) throw new Error(`Chromium reported errors:\n${browserErrors.join("\n")}`);

    console.log(`Short-message first authored text: ${Buffer.byteLength(MESSAGE, "utf8")} bytes; ${RUNS_PER_ENGINE} fresh pages per engine.`);
    console.log("First-content clock starts immediately before append(); inline-code readiness waits for the heading, two paragraphs, three code spans, and three list items.");
    console.log("Worker startup is measured separately from component mount to the public workerReady state.");
    console.log("| engine | n | content median ms | p95 ms | max ms | inline-code ready median ms | p95 ms | max ms | startup median ms | p95 ms | max ms | 50 ms auto gate |");
    console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
    let autoP95 = Number.NaN;
    for (const engine of ["auto", "worker"] as const) {
      const engineResults = results.filter((result) => result.engine === engine);
      const firstContent = engineResults.map((result) => result.firstContentMs);
      const decorations = engineResults.map((result) => result.inlineDecorationReadyMs);
      const startups = engineResults.flatMap((result) => result.workerStartupMs === null ? [] : [result.workerStartupMs]);
      const p95 = percentile(firstContent, 0.95);
      if (engine === "auto") autoP95 = p95;
      const gate = engine === "auto" ? (p95 <= LATENCY_BUDGET_MS ? "PASS" : "FAIL") : "—";
      console.log(
        `| ${engine} | ${engineResults.length} | ${formatMs(median(firstContent))} | ${formatMs(p95)} | ${formatMs(Math.max(...firstContent))} | ${formatMs(median(decorations))} | ${formatMs(percentile(decorations, 0.95))} | ${formatMs(Math.max(...decorations))} | ${formatMs(startups.length ? median(startups) : null)} | ${formatMs(startups.length ? percentile(startups, 0.95) : null)} | ${formatMs(startups.length ? Math.max(...startups) : null)} | ${gate} |`,
      );
    }
    console.log(`Auto p95 ${formatMs(autoP95)} ms ${autoP95 <= LATENCY_BUDGET_MS ? "PASS" : "FAIL"} against ${LATENCY_BUDGET_MS} ms.`);
    if (autoP95 > LATENCY_BUDGET_MS) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await rm(outputDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
