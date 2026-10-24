import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToString } from "react-dom/server";
import { chromium, type Browser, type Page } from "playwright";
import { build } from "tsup";
import { compileMarkdownSnapshot } from "@stream-mdx/worker/node";
import { MarkdownBlocksRenderer } from "@stream-mdx/react/server";
import { createMermaidSmokeRenderers, COOL_MARKDOWN, WARM_MARKDOWN } from "./p8-mermaid-smoke-components";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_FIXTURE = path.join(REPO_ROOT, "scripts", "p8-mermaid-browser-fixture.tsx");
const WORKER_BUNDLE = path.join(REPO_ROOT, "packages", "markdown-v2-worker", "dist", "hosted", "markdown-worker.js");
const TIMEOUT_MS = 120_000;
const WARM_SOURCE = [
  "flowchart TD",
  '  WarmStart["Warm start"] --> WarmEnd["Warm end"]',
].join("\n");

type SmokeWindow = Window & {
  __P8_MERMAID_SMOKE__?: {
    bindCount: number;
    disposeCount: number;
    activeBindings: number;
    bindSources: string[];
    disposedSources: string[];
    hydrationErrors: string[];
    workerMessages: string[];
    hydrated: boolean;
    startStream?: () => Promise<void>;
    startCleanup?: () => void;
    replaceCleanupSource?: () => void;
    unmountCleanup?: () => void;
  };
};

async function waitForDiagram(page: Page, rootSelector: string, label: string): Promise<void> {
  await page.waitForFunction(
    ({ selector, expectedLabel }) => {
      const root = document.querySelector(selector);
      return Array.from(root?.querySelectorAll("svg") ?? []).some((svg) => svg.textContent?.includes(expectedLabel));
    },
    { selector: rootSelector, expectedLabel: label },
    { timeout: TIMEOUT_MS },
  );
}

async function svgForLabel(page: Page, rootSelector: string, label: string): Promise<{ text: string; markup: string }> {
  const result = await page.locator(`${rootSelector} svg`).evaluateAll((svgs, expectedLabel) => {
    const svg = svgs.find((candidate) => candidate.textContent?.includes(expectedLabel));
    return svg ? { text: svg.textContent ?? "", markup: svg.outerHTML } : null;
  }, label);
  assert.ok(result, `real Mermaid SVG contains the expected label: ${label}`);
  return result;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "stream-mdx-p8-mermaid-"));
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
      globalName: "StreamMDXP8MermaidSmoke",
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
    assert.ok(bundleName, "the real Mermaid fixture bundles for Chromium");
    const bundlePath = path.join(outputDir, bundleName);
    const { blocks } = await compileMarkdownSnapshot({
      text: `${WARM_MARKDOWN}\n\n${COOL_MARKDOWN}`,
      init: {
        docPlugins: { tables: false, html: false, mdx: false, math: false, footnotes: false, callouts: false },
        prewarmLangs: [],
      },
    });
    const serverRenderers = createMermaidSmokeRenderers();
    const ssrMarkup = renderToString(
      React.createElement(MarkdownBlocksRenderer, {
        blocks,
        codeRenderers: serverRenderers.codeRenderers,
      }),
    );
    assert.ok(ssrMarkup.includes("stream-mdx-mermaid-placeholder"), "the server renderer emits inert Mermaid fallback markup");
    const serializedBlocks = JSON.stringify(blocks).replaceAll("<", "\\u003c");
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="hydration-root">${ssrMarkup}</div><script id="p8-ssr-blocks" type="application/json">${serializedBlocks}</script><div id="stream-root"></div><div id="cleanup-root"></div><script src="/app.js" defer></script></body></html>`;
    let workerRequests = 0;

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
    assert.ok(address && typeof address !== "string", "the smoke server binds a local TCP port");
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
    await page.waitForFunction(() => (window as SmokeWindow).__P8_MERMAID_SMOKE__?.hydrated === true, undefined, { timeout: TIMEOUT_MS });

    await page.evaluate(async () => {
      const fixture = (window as SmokeWindow).__P8_MERMAID_SMOKE__;
      if (!fixture?.startStream) throw new Error("the Mermaid stream fixture did not initialize");
      await fixture.startStream();
    });
    await waitForDiagram(page, "#stream-root", "Warm start");
    const streamedSvg = await svgForLabel(page, "#stream-root", "Warm start");
    assert.ok(streamedSvg.text.includes("Warm end"), "the streamed real SVG contains both authored node labels");
    assert.match(streamedSvg.markup, /<svg[\s>]/i, "Mermaid renders a real SVG element");

    const streamBlock = page.locator("#stream-root .stream-mdx-mermaid-block");
    const disposeBeforeCodeView = await page.evaluate(() => (window as SmokeWindow).__P8_MERMAID_SMOKE__?.disposeCount ?? 0);
    await streamBlock.getByRole("button", { name: "Code", exact: true }).click();
    await page.waitForFunction(
      (expected) => document.querySelector("#stream-root .stream-mdx-mermaid-block pre")?.textContent?.includes(expected),
      "WarmStart",
      { timeout: TIMEOUT_MS },
    );
    const codeText = await streamBlock.locator("pre").innerText();
    assert.ok(codeText.includes("flowchart TD") && codeText.includes("WarmStart") && codeText.includes("Warm end"), "Code view shows the authored Mermaid source");
    await page.waitForFunction(
      (previousCount) => ((window as SmokeWindow).__P8_MERMAID_SMOKE__?.disposeCount ?? 0) > previousCount,
      disposeBeforeCodeView,
      { timeout: TIMEOUT_MS },
    );
    await streamBlock.getByRole("button", { name: "Diagram", exact: true }).click();
    await waitForDiagram(page, "#stream-root", "Warm start");

    await waitForDiagram(page, "#hydration-root", "Warm start");
    await waitForDiagram(page, "#hydration-root", "Cool start");
    const warmSvg = await svgForLabel(page, "#hydration-root", "Warm start");
    const coolSvg = await svgForLabel(page, "#hydration-root", "Cool start");
    assert.ok(warmSvg.markup.toLowerCase().includes("#fef08a"), "the warm diagram receives only its isolated theme color");
    assert.ok(!warmSvg.markup.toLowerCase().includes("#bfdbfe"), "the cool diagram configuration does not leak into the warm SVG");
    assert.ok(coolSvg.markup.toLowerCase().includes("#bfdbfe"), "the cool diagram receives only its isolated theme color");
    assert.ok(!coolSvg.markup.toLowerCase().includes("#fef08a"), "the warm diagram configuration does not leak into the cool SVG");

    const activeBindingsBeforeCleanup = await page.evaluate(() => (window as SmokeWindow).__P8_MERMAID_SMOKE__?.activeBindings ?? 0);
    await page.evaluate(() => {
      const fixture = (window as SmokeWindow).__P8_MERMAID_SMOKE__;
      if (!fixture?.startCleanup) throw new Error("the binding cleanup fixture did not initialize");
      fixture.startCleanup();
    });
    await waitForDiagram(page, "#cleanup-root", "Cleanup initial");
    await page.waitForFunction(
      () => (window as SmokeWindow).__P8_MERMAID_SMOKE__?.bindSources.some((source) => source.includes("CleanupStart")) === true,
      undefined,
      { timeout: TIMEOUT_MS },
    );
    const disposeBeforeReplacement = await page.evaluate(() => (window as SmokeWindow).__P8_MERMAID_SMOKE__?.disposeCount ?? 0);
    await page.evaluate(() => {
      const fixture = (window as SmokeWindow).__P8_MERMAID_SMOKE__;
      if (!fixture?.replaceCleanupSource) throw new Error("the binding replacement fixture did not initialize");
      fixture.replaceCleanupSource();
    });
    await waitForDiagram(page, "#cleanup-root", "Replaced node");
    await page.waitForFunction(
      () => {
        const fixture = (window as SmokeWindow).__P8_MERMAID_SMOKE__;
        return fixture?.disposedSources.some((source) => source.includes("CleanupStart")) === true
          && fixture.bindSources.some((source) => source.includes("ReplacedStart")) === true;
      },
      undefined,
      { timeout: TIMEOUT_MS },
    );
    const replacementCounts = await page.evaluate(() => {
      const fixture = (window as SmokeWindow).__P8_MERMAID_SMOKE__;
      return { active: fixture?.activeBindings ?? -1, disposed: fixture?.disposeCount ?? 0 };
    });
    assert.equal(replacementCounts.disposed, disposeBeforeReplacement + 1, "replacing diagram source runs its prior binding disposer");
    assert.equal(replacementCounts.active, activeBindingsBeforeCleanup + 1, "the replacement owns one live binding after the old one is disposed");

    await page.evaluate(() => {
      const fixture = (window as SmokeWindow).__P8_MERMAID_SMOKE__;
      if (!fixture?.unmountCleanup) throw new Error("the binding unmount fixture did not initialize");
      fixture.unmountCleanup();
    });
    await page.waitForFunction(
      () => (window as SmokeWindow).__P8_MERMAID_SMOKE__?.disposedSources.some((source) => source.includes("ReplacedStart")) === true,
      undefined,
      { timeout: TIMEOUT_MS },
    );
    const finalBindings = await page.evaluate(() => {
      const fixture = (window as SmokeWindow).__P8_MERMAID_SMOKE__;
      return {
        active: fixture?.activeBindings ?? -1,
        hydrationErrors: fixture?.hydrationErrors ?? [],
        workerMessages: fixture?.workerMessages ?? [],
      };
    });
    assert.equal(finalBindings.active, activeBindingsBeforeCleanup, "unmount releases its diagram binding without affecting other mounted views");
    assert.deepEqual(finalBindings.hydrationErrors, [], "SSR markup hydrates cold without recoverable mismatch warnings");
    assert.ok(workerRequests > 0, "Chromium fetches the hosted Worker bundle from the local server");
    assert.ok(finalBindings.workerMessages.includes("INITIALIZED"), "the renderer initializes through its Worker");
    assert.ok(finalBindings.workerMessages.includes("PATCH"), "the streamed Mermaid fence crosses the Worker boundary");
    assert.ok(finalBindings.workerMessages.includes("FINALIZED"), "the streamed Mermaid fence is finalized by the Worker");
    assert.deepEqual(consoleErrors, [], "Chromium reports zero console errors across the full journey");
    assert.deepEqual(pageErrors, [], "the browser fixture reports no uncaught errors");

    console.log(`p8-mermaid-browser-smoke: PASS (${Date.now() - startedAt}ms)`);
    console.log("Real Mermaid SVG streaming, view switching, isolated config, cold SSR hydration and binding cleanup passed in Chromium with zero console errors.");
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
