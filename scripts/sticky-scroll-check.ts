import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

type Mode = "STICKY_INSTANT" | "DETACHED" | "RETURNING_SMOOTH";

type DebugState = {
  mode: Mode;
  isOverflowing: boolean;
  distanceToBottom: number;
  programmaticWrites: number;
};

function isIgnorableConsoleError(message: string) {
  const lower = message.toLowerCase();
  return (
    lower.includes("a tree hydrated but some attributes of the server rendered html didn't match") &&
    lower.includes("hydration-mismatch")
  );
}

function fail(message: string): never {
  throw new Error(`[sticky-scroll-check] ${message}`);
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-");
}

async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  stepMs = 25,
): Promise<T> {
  const started = Date.now();
  let last: T | undefined;
  while (Date.now() - started <= timeoutMs) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return fail(`timed out after ${timeoutMs}ms; last value: ${JSON.stringify(last)}`);
}

async function main() {
  const stickyUrl = process.env.STICKY_SCROLL_URL ?? "http://127.0.0.1:3006/demo/sticky-scroll/";
  const stickyOrigin = new URL(stickyUrl).origin;
  const demoUrl = process.env.STICKY_SCROLL_DEMO_URL ?? `${stickyOrigin}/demo/`;
  const docsUrl = process.env.STICKY_SCROLL_DOCS_URL ?? `${stickyOrigin}/docs/getting-started/`;
  const evidenceDir =
    process.env.STICKY_SCROLL_EVIDENCE_DIR ??
    path.join("tmp", "sticky-scroll-check", timestamp().replaceAll(".", "-"));

  await fs.mkdir(evidenceDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultNavigationTimeout(120_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (isIgnorableConsoleError(text)) return;
    consoleErrors.push(text);
  });

  page.on("pageerror", (err) => {
    pageErrors.push(String(err));
  });

  const getDebug = async (): Promise<DebugState> => {
    return await page.evaluate(() => {
      const viewport = document.querySelector("[data-testid='sticky-scroll-viewport']") as HTMLDivElement | null;
      if (!viewport) {
        throw new Error("viewport not found");
      }
      const mode = (viewport.dataset.stickyMode ?? "STICKY_INSTANT") as Mode;
      return {
        mode,
        isOverflowing: viewport.dataset.isOverflowing === "1",
        distanceToBottom: Number(viewport.dataset.distanceToBottom ?? "0"),
        programmaticWrites: Number(viewport.dataset.programmaticWrites ?? "0"),
      };
    });
  };

  const ensureApi = async () => {
    await page.evaluate(() => {
      if (!window.__stickyScrollTest) {
        throw new Error("window.__stickyScrollTest is not available");
      }
    });
  };

  const capture = async (name: string) => {
    await page.screenshot({
      path: path.join(evidenceDir, `${name}.png`),
      fullPage: true,
    });
  };

  try {
    await page.goto(stickyUrl, { waitUntil: "domcontentloaded" });
    await capture("01-sticky-initial");

    await waitFor(
      async () => page.evaluate(() => Boolean(window.__stickyScrollTest)),
      Boolean,
      20_000,
      50,
    );

    await ensureApi();
    await page.evaluate(() => {
      window.__stickyScrollTest?.pause();
      window.__stickyScrollTest?.clear();
      window.__stickyScrollTest?.burst(180);
    });
    await capture("02-sticky-burst-primed");

    await waitFor(getDebug, (debug) => debug.isOverflowing, 3000);
    await waitFor(getDebug, (debug) => debug.mode === "STICKY_INSTANT" && debug.distanceToBottom <= 2, 3000);

    await page.evaluate(() => {
      const viewport = document.querySelector("[data-testid='sticky-scroll-viewport']") as HTMLDivElement | null;
      if (!viewport) throw new Error("viewport missing for detach");
      viewport.scrollTop = Math.max(0, viewport.scrollTop - 320);
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await capture("03-sticky-detached");

    await waitFor(getDebug, (debug) => debug.mode === "DETACHED", 2000);
    const detachedStart = await getDebug();
    await page.evaluate(() => {
      window.__stickyScrollTest?.burst(40);
    });
    const detachedAfterBurst = await waitFor(getDebug, (debug) => debug.distanceToBottom > detachedStart.distanceToBottom + 8, 2000);

    if (detachedAfterBurst.distanceToBottom < 140) {
      await page.evaluate(() => {
        const viewport = document.querySelector("[data-testid='sticky-scroll-viewport']") as HTMLDivElement | null;
        if (!viewport) throw new Error("viewport missing for deep detach");
        viewport.scrollTop = Math.max(0, viewport.scrollTop - 500);
        viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      await waitFor(getDebug, (debug) => debug.mode === "DETACHED" && debug.distanceToBottom >= 140, 2000);
    }

    await page.evaluate(() => {
      window.__stickyScrollTest?.setIntervalMs(70);
      window.__stickyScrollTest?.resume();
    });
    await page.waitForSelector("[data-testid='sticky-scroll-jump']", { state: "visible", timeout: 5000 });
    const clicked = await page.evaluate(() => {
      const button = document.querySelector("[data-testid='sticky-scroll-jump']") as HTMLButtonElement | null;
      if (!button) return false;
      button.click();
      return true;
    });
    if (!clicked) {
      fail("jump button was not found for primary return test");
    }
    await capture("04-sticky-return-clicked");

    const modeAfterClick = await waitFor(
      getDebug,
      (debug) => debug.mode !== "DETACHED",
      2500,
    );

    const distanceSamples =
      modeAfterClick.mode === "RETURNING_SMOOTH"
        ? ((await page.evaluate(`
      new Promise((resolve) => {
        const viewport = document.querySelector("[data-testid='sticky-scroll-viewport']");
        if (!viewport) {
          throw new Error("viewport missing for sampling");
        }
        const samples = [];
        const started = performance.now();
        function frame() {
          samples.push(Number(viewport.dataset.distanceToBottom || "0"));
          if (performance.now() - started >= 750) {
            resolve(samples);
            return;
          }
          requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      });
    `)) as number[])
        : [modeAfterClick.distanceToBottom];

    const maxFrameDrop = distanceSamples.slice(1).reduce((max, sample, index) => {
      const drop = distanceSamples[index] - sample;
      return drop > max ? drop : max;
    }, 0);

    const stickyAfterReturn = await waitFor(
      getDebug,
      (debug) => debug.mode === "STICKY_INSTANT" && debug.distanceToBottom <= 2,
      3000,
    );
    await capture("05-sticky-return-complete");

    await page.evaluate(() => {
      const viewport = document.querySelector("[data-testid='sticky-scroll-viewport']") as HTMLDivElement | null;
      if (!viewport) throw new Error("viewport missing for cancel test");
      viewport.scrollTop = Math.max(0, viewport.scrollTop - 250);
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await waitFor(getDebug, (debug) => debug.mode === "DETACHED", 1500);

    await page.waitForSelector("[data-testid='sticky-scroll-jump']", { state: "visible", timeout: 5000 });
    const cancelClicked = await page.evaluate(() => {
      const button = document.querySelector("[data-testid='sticky-scroll-jump']") as HTMLButtonElement | null;
      if (!button) return false;
      button.click();
      return true;
    });
    if (!cancelClicked) {
      fail("jump button was not found for cancel test");
    }
    await waitFor(getDebug, (debug) => debug.mode === "RETURNING_SMOOTH", 1500);

    await page.evaluate(() => {
      const viewport = document.querySelector("[data-testid='sticky-scroll-viewport']") as HTMLDivElement | null;
      if (!viewport) throw new Error("viewport missing for cancel gesture");
      viewport.scrollTop = Math.max(0, viewport.scrollTop - 180);
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    await waitFor(getDebug, (debug) => debug.mode === "DETACHED", 1500);
    await page.evaluate(() => {
      window.__stickyScrollTest?.pause();
    });
    await capture("06-sticky-cancelled");

    const finalDebug = await getDebug();
    if (!detachedAfterBurst.isOverflowing) {
      fail("expected overflow in detached mode");
    }
    if (!distanceSamples.length || maxFrameDrop > 200) {
      fail(`unexpected jump during smooth return; max frame-to-frame drop=${maxFrameDrop.toFixed(2)}px`);
    }
    if (stickyAfterReturn.distanceToBottom > 2) {
      fail(`sticky return did not finish at bottom (distance=${stickyAfterReturn.distanceToBottom.toFixed(2)}px)`);
    }

    await page.goto(demoUrl, { waitUntil: "domcontentloaded" });
    await waitFor(
      async () => page.locator("h1").first().textContent(),
      (value) => (value ?? "").toLowerCase().includes("streaming markdown demo"),
      5000,
    );
    await capture("07-demo-surface");

    const demoMainTextLength = await page.evaluate(() => {
      const main = document.querySelector("main");
      return main?.textContent?.trim().length ?? 0;
    });
    if (demoMainTextLength < 120) {
      fail(`demo surface looks under-rendered (main text length=${demoMainTextLength})`);
    }

    await page.goto(docsUrl, { waitUntil: "domcontentloaded" });
    await waitFor(
      async () => page.locator("h1").first().textContent(),
      (value) => (value ?? "").toLowerCase().includes("getting started"),
      5000,
    );
    await capture("08-docs-surface");

    const docsCodeBlocks = await page.locator("pre").count();
    if (docsCodeBlocks < 1) {
      fail("docs getting-started surface is missing code blocks");
    }

    const report = {
      ok: true,
      urls: { stickyUrl, demoUrl, docsUrl },
      metrics: {
        detachedAfterBurstDistance: detachedAfterBurst.distanceToBottom,
        maxFrameDrop,
        stickyAfterReturn,
        finalDebug,
        demoMainTextLength,
        docsCodeBlocks,
      },
      consoleErrors,
      pageErrors,
    };

    await fs.writeFile(path.join(evidenceDir, "sticky-scroll-report.json"), JSON.stringify(report, null, 2));

    console.log("sticky-scroll-check: PASS");
    console.log(JSON.stringify(report, null, 2));

    if (consoleErrors.length || pageErrors.length) {
      fail(
        `runtime errors captured (console=${consoleErrors.length}, pageErrors=${pageErrors.length}); see ${path.join(evidenceDir, "sticky-scroll-report.json")}`,
      );
    }
  } finally {
    await page.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
