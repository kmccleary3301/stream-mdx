import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser } from "playwright";
import { build } from "tsup";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(REPO_ROOT, "scripts", "p4-viewport-browser-fixture.ts");
const TIMEOUT_MS = 120_000;


async function main(): Promise<void> {
  const startedAt = Date.now();
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "stream-mdx-p4-viewport-"));
  let server: Server | null = null;
  let browser: Browser | null = null;

  try {
    await build({
      entry: { app: FIXTURE },
      outDir: outputDir,
      format: "iife",
      globalName: "StreamMDXP4ViewportSmoke",
      platform: "browser",
      target: "chrome120",
      bundle: true,
      clean: false,
      dts: false,
      config: false,
      minify: false,
      replaceNodeEnv: true,
    });
    const outputFiles = await readdir(outputDir);
    const bundleName = outputFiles.find((file) => file.endsWith(".js"));
    assert.ok(bundleName, "the public React fixture should bundle for Chromium");
    const bundlePath = path.join(outputDir, bundleName);
    const html = "<!doctype html><html><head><meta charset='utf-8'><style>html,body{margin:0;padding:0}#root{width:800px;margin:0 auto}</style></head><body><div id='root'></div><script src='/app.js' defer></script></body></html>";

    server = createServer((request, response) => {
      if (request.url === "/app.js") {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        createReadStream(bundlePath).pipe(response);
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
    const context = await browser.newContext({ acceptDownloads: true });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const page = await context.newPage({ viewport: { width: 1024, height: 800 } });
    page.setDefaultTimeout(TIMEOUT_MS);
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.goto(origin, { waitUntil: "load", timeout: TIMEOUT_MS });
    await page.evaluate(async () => {
      const fixture = (window as Window & {
        __P4_VIEWPORT_SMOKE__?: { start?: () => Promise<void> };
      }).__P4_VIEWPORT_SMOKE__;
      if (!fixture?.start) throw new Error("the public fixture cannot append initial source");
      await fixture.start();
    });

    const table = page.locator('[data-table-virtualized="true"]');
    try {
      await page.waitForFunction(() => {
        const viewport = document.querySelector<HTMLElement>('[data-table-virtualized="true"]');
        return viewport?.getAttribute("data-table-total-rows") === "10000" && viewport.textContent?.includes("Row-0");
      }, undefined, { timeout: 30_000 });
    } catch (error) {
      const snapshot = await page.evaluate(() => ({
        bodyText: document.body.innerText.slice(0, 1_000),
        rootHtml: document.querySelector("#root")?.innerHTML.slice(0, 1_500) ?? "",
      }));
      throw new Error(
        `table viewport did not mount; console=${JSON.stringify(consoleErrors)}; pageErrors=${JSON.stringify(pageErrors)}; snapshot=${JSON.stringify(snapshot)}; cause=${String(error)}`,
      );
    }
    const initialTableWidths = await table.locator("col").evaluateAll((columns) =>
      columns.map((column) => getComputedStyle(column).width),
    );
    assert.equal(initialTableWidths.length, 2, "the 10,000-row table exposes both measured columns");
    const initialBodyRows = await table.locator("tbody tr[data-row-id]").count();
    assert.ok(initialBodyRows < 10_000, `the browser mounts a bounded table window, not ${initialBodyRows} rows`);
    const initialFirstRow = table.locator("tbody tr[data-row-id]").first();
    const initialFirstRowId = await initialFirstRow.getAttribute("data-row-id");
    const initialFirstRowCellWidths = await initialFirstRow.locator("th, td").evaluateAll((cells) =>
      cells.map((cell) => cell.getBoundingClientRect().width),
    );
    assert.ok(initialFirstRowId, "the table exposes its first rendered row");
    assert.equal(initialFirstRowCellWidths.length, 2, "the first rendered row exposes both table cells");
    await page.evaluate(async () => {
      const fixture = (window as Window & {
        __P4_VIEWPORT_SMOKE__?: { start?: () => Promise<void>; appendLiveTableRow?: () => Promise<void> };
      }).__P4_VIEWPORT_SMOKE__;
      if (!fixture?.appendLiveTableRow) throw new Error("the public fixture cannot append a live table row");
      await fixture.appendLiveTableRow();
    });
    await page.waitForFunction(() =>
      document.querySelector<HTMLElement>('[data-table-virtualized="true"]')?.getAttribute("data-table-total-rows") === "10001",
    undefined, { timeout: TIMEOUT_MS });
    const appendedFirstRow = table.locator("tbody tr[data-row-id]").first();
    assert.equal(
      await appendedFirstRow.getAttribute("data-row-id"),
      initialFirstRowId,
      "the first rendered row stays mounted during the live append",
    );
    const appendedFirstRowCellWidths = await appendedFirstRow.locator("th, td").evaluateAll((cells) =>
      cells.map((cell) => cell.getBoundingClientRect().width),
    );
    assert.equal(appendedFirstRowCellWidths.length, initialFirstRowCellWidths.length);
    for (const [cellIndex, initialWidth] of initialFirstRowCellWidths.entries()) {
      const appendedWidth = appendedFirstRowCellWidths[cellIndex];
      assert.ok(appendedWidth !== undefined);
      assert.ok(
        Math.abs(appendedWidth - initialWidth) <= 0.5,
        `rendered width of first-row cell ${cellIndex} changed from ${initialWidth}px to ${appendedWidth}px after the live append`,
      );
    }

    await table.evaluate((element) => {
      const viewport = element as HTMLElement;
      viewport.scrollTop = viewport.scrollHeight;
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.waitForFunction(() => {
      const viewport = document.querySelector<HTMLElement>('[data-table-virtualized="true"]');
      return viewport?.textContent?.includes("Row-9999") && viewport.textContent.includes("Live-append-row");
    }, undefined, { timeout: TIMEOUT_MS });
    const tailTableWidths = await table.locator("col").evaluateAll((columns) =>
      columns.map((column) => getComputedStyle(column).width),
    );
    assert.deepEqual(tailTableWidths, initialTableWidths, "table column widths remain stable after the live append and tail scroll");
    const tailBodyRows = await table.locator("tbody tr[data-row-id]").count();
    assert.ok(tailBodyRows < 100, `the browser keeps the tail table window bounded (${tailBodyRows} rows)`);
    await table.evaluate((element) => {
      const viewport = element as HTMLElement;
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.waitForFunction(() =>
      document.querySelector<HTMLElement>('[data-table-virtualized="true"]')?.textContent?.includes("Row-0") ?? false,
    undefined, { timeout: TIMEOUT_MS });
    assert.deepEqual(
      await table.locator("col").evaluateAll((columns) => columns.map((column) => getComputedStyle(column).width)),
      initialTableWidths,
      "table column widths remain stable after returning to the start",
    );

    const code = page.locator('[data-code-virtualized="true"]');
    const codeViewport = page.locator('[data-code-virtualized="true"] .markdown-code-block-container');
    await page.waitForFunction(() => {
      const wrapper = document.querySelector<HTMLElement>('[data-code-virtualized="true"]');
      return Number(wrapper?.getAttribute("data-code-total-lines")) >= 5_000 &&
        wrapper?.querySelector('.line[data-line="1"]') !== null;
    }, undefined, { timeout: TIMEOUT_MS });
    const codeViewportCount = await codeViewport.count();
    if (codeViewportCount !== 1) {
      const renderedClasses = await code.evaluate((element) =>
        Array.from(element.querySelectorAll<HTMLElement>("[class]"), (child) => `${child.tagName.toLowerCase()}.${child.className}`),
      );
      throw new Error(`expected one code viewport, found ${codeViewportCount}; rendered classes: ${JSON.stringify(renderedClasses)}`);
    }
    await codeViewport.scrollIntoViewIfNeeded();
    const codeViewportBounds = await codeViewport.boundingBox();
    assert.ok(codeViewportBounds, "the code viewport is visible for browser scrolling");
    await page.mouse.move(
      codeViewportBounds.x + codeViewportBounds.width / 2,
      codeViewportBounds.y + codeViewportBounds.height / 2,
    );
    for (let step = 0; step < 20; step += 1) {
      await page.mouse.wheel(0, 5_000);
      await page.waitForTimeout(25);
    }
    await page.waitForFunction(() =>
      document.querySelector<HTMLElement>('[data-code-virtualized="true"]')?.querySelector('.line[data-line="5000"]') !== null,
    undefined, { timeout: 15_000 });
    assert.ok((await code.textContent())?.includes("codeLine04999"), "the last authored code line is reachable");
    for (let step = 0; step < 20; step += 1) {
      await page.mouse.wheel(0, -5_000);
      await page.waitForTimeout(25);
    }
    await page.waitForFunction(() =>
      document.querySelector<HTMLElement>('[data-code-virtualized="true"]')?.querySelector('.line[data-line="1"]') !== null,
    undefined, { timeout: TIMEOUT_MS });
    assert.ok((await code.textContent())?.includes("codeLine00000"), "returning to the top restores the first code line");

    const lineHeight = await codeViewport.locator('.line[data-line="1"]').evaluate((line) => line.getBoundingClientRect().height);
    const targetScrollTop = lineHeight * 2_500;
    let codeWindow = await codeViewport.evaluate((element) => {
      const viewport = element as HTMLElement;
      const rows = Array.from(viewport.querySelectorAll<HTMLElement>(".line[data-line]"));
      return {
        scrollTop: viewport.scrollTop,
        firstLine: Number(rows[0]?.dataset.line ?? "0"),
        lastLine: Number(rows.at(-1)?.dataset.line ?? "0"),
      };
    });
    for (let step = 0; step < 120; step += 1) {
      if (codeWindow.firstLine <= 2_501 && codeWindow.lastLine >= 2_502) break;
      await page.mouse.wheel(0, codeWindow.scrollTop < targetScrollTop ? 1_000 : -1_000);
      await page.waitForTimeout(25);
      codeWindow = await codeViewport.evaluate((element) => {
        const viewport = element as HTMLElement;
        const rows = Array.from(viewport.querySelectorAll<HTMLElement>(".line[data-line]"));
        return {
          scrollTop: viewport.scrollTop,
          firstLine: Number(rows[0]?.dataset.line ?? "0"),
          lastLine: Number(rows.at(-1)?.dataset.line ?? "0"),
        };
      });
    }
    assert.ok(
      codeWindow.firstLine <= 2_501 && codeWindow.lastLine >= 2_502,
      `the virtualized browser viewport reaches the selection rows (${JSON.stringify(codeWindow)})`,
    );
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    }));

    const mousePoints = await page.evaluate(() => {
      const firstRow = document.querySelector<HTMLElement>('[data-code-virtualized="true"] .line[data-line="2501"]');
      const lastRow = document.querySelector<HTMLElement>('[data-code-virtualized="true"] .line[data-line="2502"]');
      if (!firstRow || !lastRow) throw new Error("selection rows are not mounted");
      if (
        firstRow.textContent !== 'const codeLine02500 = "source-2500";' ||
        lastRow.textContent !== 'const codeLine02501 = "source-2501";'
      ) {
        throw new Error(`selection row source mismatch: ${firstRow.textContent}, ${lastRow.textContent}`);
      }
      const firstWalker = document.createTreeWalker(firstRow, NodeFilter.SHOW_TEXT);
      const firstText = firstWalker.nextNode() as Text | null;
      const lastWalker = document.createTreeWalker(lastRow, NodeFilter.SHOW_TEXT);
      let lastText: Text | null = null;
      while (lastWalker.nextNode()) lastText = lastWalker.currentNode as Text;
      if (!firstText?.length || !lastText?.length) throw new Error("selection rows have no authored text nodes");
      const firstCharacter = document.createRange();
      firstCharacter.setStart(firstText, 0);
      firstCharacter.setEnd(firstText, 1);
      const lastCharacter = document.createRange();
      lastCharacter.setStart(lastText, lastText.length - 1);
      lastCharacter.setEnd(lastText, lastText.length);
      const start = firstCharacter.getBoundingClientRect();
      const end = lastCharacter.getBoundingClientRect();
      return {
        start: { x: start.left + Math.max(0.25, start.width * 0.1), y: start.top + start.height / 2 },
        end: { x: end.right - Math.max(0.25, end.width * 0.1), y: end.top + end.height / 2 },
      };
    });
    await page.mouse.move(mousePoints.start.x, mousePoints.start.y);
    await page.mouse.down();
    await page.mouse.move(mousePoints.end.x, mousePoints.end.y, { steps: 12 });
    await page.mouse.up();
    const selectionText = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    assert.ok(
      selectionText.includes("codeLine02500") && selectionText.includes("codeLine02501"),
      `real mouse drag selects across adjacent code rows (selection=${JSON.stringify(selectionText)}, points=${JSON.stringify(mousePoints)})`,
    );
    const expectedSelection = await page.evaluate(() => {
      const source = window.__P4_VIEWPORT_SMOKE__?.authoredCode;
      if (!source) throw new Error("public fixture source is unavailable");
      return source.split("\r\n").slice(2_500, 2_502).join("\r\n");
    });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+C");
    const copiedSelection = await page.evaluate(async () => navigator.clipboard.readText());
    assert.equal(copiedSelection, expectedSelection, "native cross-row clipboard copy preserves the exact authored CRLF selection");

    const downloadButton = page.locator('button[data-stream-mdx-action="download"]');
    await downloadButton.waitFor({ state: "visible", timeout: TIMEOUT_MS });
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: TIMEOUT_MS }),
      downloadButton.click(),
    ]);
    assert.equal(download.suggestedFilename(), "snippet.ts");
    const downloadPath = path.join(outputDir, download.suggestedFilename());
    await download.saveAs(downloadPath);
    const downloadedBytes = await readFile(downloadPath);
    const authoredCode = await page.evaluate(() => window.__P4_VIEWPORT_SMOKE__?.authoredCode ?? "");
    assert.ok(authoredCode.endsWith("\r\n"), "fixture source carries its authored trailing CRLF");
    assert.deepEqual(downloadedBytes, Buffer.from(authoredCode), "download Blob preserves all authored CRLF bytes and the trailing newline");

    assert.deepEqual(consoleErrors, [], "Chromium reports no console errors");
    assert.deepEqual(pageErrors, [], "the public React surface reports no uncaught browser errors");
    console.log(`p4-viewport-browser-smoke: PASS (${Date.now() - startedAt}ms)`);
    console.log("10,000 table rows plus a live append and 5,000 code lines stayed bounded; widths stayed stable; CRLF selection and full-source Blob download matched.");
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
