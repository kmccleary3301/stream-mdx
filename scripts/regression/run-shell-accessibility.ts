import assert from "node:assert";

import { chromium, type Page } from "@playwright/test";

const BASE_URL = process.env.STREAM_MDX_REGRESSION_BASE_URL || "http://localhost:3000";

async function openCommandPalette(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  await page.waitForSelector('[role="dialog"][aria-modal="true"]', { timeout: 8000 });
  const activeRole = await page.evaluate(() => document.activeElement?.tagName.toLowerCase());
  assert.strictEqual(activeRole, "input", "command palette should focus the search input after keyboard open");
}

async function checkCommandPalette(page: Page): Promise<void> {
  await openCommandPalette(page);
  await page.keyboard.type("protocol");
  await page.waitForFunction(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return Boolean(dialog && (dialog.textContent ?? "").toLowerCase().includes("protocol"));
  });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
}

async function checkMobileNavigation(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/studio/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".studio-page", { timeout: 12000 });
  const summary = page.locator("summary", { hasText: /open navigation/i }).first();
  await summary.click();
  const visibleLinks = await page.locator("details[open] a").evaluateAll((links) => links.map((link) => link.textContent?.trim()).filter(Boolean));
  assert.ok(visibleLinks.some((text) => text?.includes("Studio")), "mobile navigation should expose Studio");
  assert.ok(visibleLinks.some((text) => text?.includes("Protocol")), "mobile navigation should expose Protocol");
  assert.ok(visibleLinks.some((text) => text?.includes("Internals")), "mobile navigation should expose Internals");
}

async function checkStudioSamples(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${BASE_URL}/studio/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".studio-sample-button", { timeout: 12000 });
  await page.waitForSelector('.studio-sample-grid[data-studio-ready="true"]', { timeout: 12000 });

  const sampleCount = await page.locator(".studio-sample-button").count();
  assert.ok(sampleCount >= 5, "Studio should expose at least five stress samples");

  const activeBefore = await page.locator('.studio-sample-button[aria-pressed="true"]').count();
  assert.strictEqual(activeBefore, 1, "exactly one Studio sample should be active initially");

  const largeTableButton = page.getByRole("button", { name: /large table/i });
  await largeTableButton.scrollIntoViewIfNeeded();
  await largeTableButton.click();
  await page.waitForFunction(() => document.querySelector('.studio-sample-button[aria-pressed="true"]')?.textContent?.includes("Large table"));

  const activeAfter = await page.locator('.studio-sample-button[aria-pressed="true"]').count();
  assert.strictEqual(activeAfter, 1, "exactly one Studio sample should remain active after selection");

  const rendererText = await page.locator(".studio-renderer-shell").innerText({ timeout: 12000 });
  assert.ok(rendererText.includes("Large table"), "Studio renderer header should reflect selected sample");
}

async function run(): Promise<void> {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    await checkCommandPalette(page);
    await checkMobileNavigation(page);
    await checkStudioSamples(page);
    console.log("shell accessibility checks passed");
  } finally {
    await page.close();
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
