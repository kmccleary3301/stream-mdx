import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser } from "playwright";
import { build } from "tsup";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_FIXTURE = path.join(REPO_ROOT, "scripts", "p7-syntax-extension-browser-fixture.tsx");
const WORKER_BUNDLE = path.join(REPO_ROOT, "packages", "markdown-v2-worker", "dist", "hosted", "markdown-worker.js");
const TIMEOUT_MS = 30_000;

type SmokeWindow = Window & {
  __P7_SYNTAX_SMOKE__?: {
    start: () => Promise<void>;
    workerMessages: string[];
  };
};

async function main(): Promise<void> {
  const startedAt = Date.now();
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "stream-mdx-p7-syntax-"));
  let server: Server | null = null;
  let browser: Browser | null = null;

  try {
    execFileSync("npm", ["-w", "@stream-mdx/worker", "run", "build:hosted"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    await build({
      entry: { app: APP_FIXTURE },
      outDir: outputDir,
      format: "iife",
      globalName: "StreamMDXP7SyntaxSmoke",
      platform: "browser",
      target: "chrome120",
      bundle: true,
      clean: false,
      dts: false,
      config: false,
      minify: true,
      replaceNodeEnv: true,
    });
    const outputFiles = await readdir(outputDir);
    const bundleName = outputFiles.find((file) => file.endsWith(".js"));
    assert.ok(bundleName, "the syntax demo should bundle as a production browser fixture");
    const bundlePath = path.join(outputDir, bundleName);
    let workerRequests = 0;
    const html = "<!doctype html><html><head><meta charset='utf-8'></head><body><div id='root'></div><script src='/app.js' defer></script></body></html>";

    server = createServer((request, response) => {
      if (request.url === "/app.js") {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        createReadStream(bundlePath).pipe(response);
        return;
      }
      if (request.url === "/workers/markdown-worker.js") {
        workerRequests += 1;
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        createReadStream(WORKER_BUNDLE).pipe(response);
        return;
      }
      if (request.url === "/" || request.url === "/index.html") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(html);
        return;
      }
      if (request.url === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string", "the smoke server should bind a local TCP port");
    const origin = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    page.setDefaultTimeout(TIMEOUT_MS);
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.goto(origin, { waitUntil: "load", timeout: TIMEOUT_MS });
    await page.evaluate(async () => {
      const fixture = (window as SmokeWindow).__P7_SYNTAX_SMOKE__;
      if (!fixture?.start) throw new Error("the syntax demo fixture cannot start its stream");
      await fixture.start();
    });
    await page.waitForFunction(() => {
      const demo = (window as SmokeWindow).__P7_SYNTAX_SMOKE__;
      const note = document.querySelector<HTMLElement>('[data-syntax-container="note"]');
      const highlight = document.querySelector<HTMLElement>('[data-syntax-highlight="true"]');
      return note?.dataset.componentStatus === "closed"
        && note.dataset.noteTitle === "Demo note"
        && highlight?.textContent === "highlight"
        && demo?.workerMessages.includes("FINALIZED");
    }, undefined, { timeout: TIMEOUT_MS });

    const workerMessages = await page.evaluate(() => (window as SmokeWindow).__P7_SYNTAX_SMOKE__?.workerMessages ?? []);
    assert.ok(workerRequests > 0, "the browser must fetch the hosted Worker bundle from the local server");
    assert.ok(workerMessages.includes("INITIALIZED"), "the renderer must receive initialization from its Worker engine");
    assert.ok(workerMessages.includes("PATCH"), "the streamed syntax output must cross the Worker boundary");
    assert.ok(workerMessages.includes("FINALIZED"), "the Worker must finalize the streamed syntax output");
    assert.deepEqual(consoleErrors, [], "Chromium reports no console errors");
    assert.deepEqual(pageErrors, [], "the syntax demo reports no uncaught browser errors");

    console.log(`p7-syntax-extension-browser-smoke: PASS (${Date.now() - startedAt}ms)`);
    console.log("Production bundle streamed the highlight and registered note through the hosted Worker in Chromium with no console errors.");
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
