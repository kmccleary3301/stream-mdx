#!/usr/bin/env tsx

import { execSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { chromium, devices } from "playwright";

import { DOC_SECTIONS } from "../apps/docs/lib/docs";
import { GUIDE_ITEMS } from "../apps/docs/content/guides";
import { SHOWCASE_ITEMS } from "../apps/docs/content/showcase";

const ROOT = path.resolve(__dirname, "..");
const DOCS_APP_DIR = path.join(ROOT, "apps", "docs");
const PORT = Number(process.env.CAPTURE_PORT ?? "3008");
const BASE_URL = process.env.CAPTURE_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const OUTPUT_DIR = process.env.CAPTURE_OUT_DIR
  ? path.resolve(process.env.CAPTURE_OUT_DIR)
  : path.join(ROOT, "tmp", "screenshots", "docs-site");
const WAIT_AFTER_LOAD_MS = Number(process.env.CAPTURE_WAIT_MS ?? "1500");
const FULL_PAGE = process.env.CAPTURE_FULL_PAGE === "1";
const MANIFEST_ONLY = process.env.CAPTURE_MANIFEST_ONLY === "1";
const FAIL_ON_ERRORS = process.env.CAPTURE_FAIL_ON_ERRORS !== "0";
const FAIL_ON_CONSOLE = process.env.CAPTURE_FAIL_ON_CONSOLE !== "0";
const FAIL_ON_OVERLAY = process.env.CAPTURE_FAIL_ON_OVERLAY !== "0";
const CONSOLE_ERROR_ALLOWLIST = (process.env.CAPTURE_CONSOLE_ALLOWLIST ?? "")
  .split(",")
  .map((part) => part.trim())
  .filter((part) => part.length > 0);
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const MOBILE_DEVICE = devices["iPhone 14 Pro"];

const CAPTURE_CSS = `
/* Disable animations/transitions so screenshots don't catch "opacity: 0" initial states. */
*, *::before, *::after {
  animation-duration: 0.001s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0.001s !important;
  transition-delay: 0s !important;
  scroll-behavior: auto !important;
}
html { scroll-behavior: auto !important; }

/* Some pages use JS-driven fade-in wrappers that set opacity/visibility without CSS transitions. */
article, #article-content-wrapper, #regression-root {
  opacity: 1 !important;
  visibility: visible !important;
}
`;

const STATIC_ROUTES = [
  "/",
  "/docs",
  "/docs/guides",
  "/docs/tui-json-protocol",
  "/guides",
  "/articles",
  "/showcase",
  "/benchmarks",
  "/perf/harness",
  "/demo",
];

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function routeToFilename(route: string): string {
  if (route === "/") return "home";
  return route.replace(/^\//, "").replace(/\//g, "__");
}

function isAllowedConsoleError(message: string): boolean {
  if (CONSOLE_ERROR_ALLOWLIST.length === 0) return false;
  return CONSOLE_ERROR_ALLOWLIST.some((pattern) => message.includes(pattern));
}

async function ensureCaptureStyles(page: import("playwright").Page): Promise<void> {
  // Idempotent: guard with a marker attribute.
  const already = await page
    .evaluate(() => Boolean(document.documentElement?.getAttribute("data-smdx-capture-css")))
    .catch(() => false);
  if (already) return;
  await page.addStyleTag({ content: CAPTURE_CSS }).catch(() => undefined);
  await page
    .evaluate(() => {
      document.documentElement?.setAttribute("data-smdx-capture-css", "1");
    })
    .catch(() => undefined);
}

async function waitForServer(url: string, retries = 45, delayMs = 1500): Promise<void> {
  let attempt = 0;
  while (attempt < retries) {
    attempt += 1;
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return;
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Server did not become ready after ${retries} attempts: ${url}`);
}

function startDevServer(): { stop: () => Promise<void> } {
  const proc = spawn("npm", ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(PORT)], {
    cwd: DOCS_APP_DIR,
    env: {
      ...process.env,
      NEXT_PUBLIC_DISABLE_ANIMATIONS: "true",
    },
    stdio: "ignore",
    detached: true,
  });

  const stop = () =>
    new Promise<void>((resolve) => {
      if (proc.killed) {
        resolve();
        return;
      }
      proc.once("exit", () => resolve());
      // Kill the whole process group so `next dev` children don't leak.
      try {
        if (typeof proc.pid === "number") {
          process.kill(-proc.pid, "SIGTERM");
        } else {
          proc.kill("SIGTERM");
        }
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          if (typeof proc.pid === "number") {
            process.kill(-proc.pid, "SIGKILL");
          } else {
            proc.kill("SIGKILL");
          }
        } catch {
          // ignore
        }
      }, 5000);
    });

  return { stop };
}

function prepareCapturePrerequisites(): void {
  execSync("npm run docs:worker:build", { cwd: ROOT, stdio: "inherit" });
  execSync("npm run docs:snapshots:build", { cwd: ROOT, stdio: "inherit" });
}

function buildRoutes(): string[] {
  const routes = buildAllRoutes();
  const only = process.env.CAPTURE_ONLY?.trim();
  if (!only) return routes;
  const allow = new Set(
    only
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
  return routes.filter((route) => allow.has(route));
}

function buildAllRoutes(): string[] {
  const docSlugs = DOC_SECTIONS.flatMap((section) => section.items.map((item) => item.slug)).filter((slug) => slug.length > 0);
  const guideSlugs = GUIDE_ITEMS.map((item) => item.slug);
  const showcaseSlugs = SHOWCASE_ITEMS.map((item) => item.slug);

  const docsRoutes = docSlugs.map((slug) => `/docs/${slug}`);
  const guideRoutes = guideSlugs.map((slug) => `/docs/guides/${slug}`);
  const showcaseRoutes = showcaseSlugs.map((slug) => `/showcase/${slug}`);

  return unique([...STATIC_ROUTES, ...docsRoutes, ...guideRoutes, ...showcaseRoutes]).sort();
}

async function captureScreenshots(): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const allRoutes = buildAllRoutes();
  const routes = buildRoutes();
  const errorsByRoute: Array<{ route: string; viewport: "desktop" | "mobile"; errors: string[] }> = [];
  const manifestPath = path.join(OUTPUT_DIR, "manifest.json");
  const writeManifest = () => {
    const missingRoutes = allRoutes.filter((route) => !routes.includes(route));
    const coverage = allRoutes.length > 0 ? Number(((routes.length / allRoutes.length) * 100).toFixed(2)) : 100;
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          baseUrl: BASE_URL,
          routes: allRoutes,
          capturedRoutes: routes,
          missingRoutes,
          routeCoveragePct: coverage,
          generatedAt: new Date().toISOString(),
          errorsByRoute,
        },
        null,
        2,
      ),
    );
  };
  writeManifest();

  if (MANIFEST_ONLY) {
    return;
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const desktopContext = await browser.newContext({
      viewport: DESKTOP_VIEWPORT,
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    });
    await desktopContext.addInitScript(() => {
      (window as Window & { __STREAMING_DEBUG__?: { mdx?: boolean; worker?: boolean } }).__STREAMING_DEBUG__ = { mdx: false, worker: false };
      // Used by /regression/snippet-test to render a deterministic screenshot.
      (window as unknown as { __TEST_SNIPPET_CONTENT__?: string }).__TEST_SNIPPET_CONTENT__ = [
        "# Snippet Test Fixture",
        "",
        "This page is used by CI and Playwright harnesses.",
        "",
        "```ts",
        "export const snippet = 1;",
        "```",
      ].join("\\n");
    });

    const mobileContext = await browser.newContext({
      ...MOBILE_DEVICE,
      reducedMotion: "reduce",
    });
    await mobileContext.addInitScript(() => {
      (window as Window & { __STREAMING_DEBUG__?: { mdx?: boolean; worker?: boolean } }).__STREAMING_DEBUG__ = { mdx: false, worker: false };
      (window as unknown as { __TEST_SNIPPET_CONTENT__?: string }).__TEST_SNIPPET_CONTENT__ = [
        "# Snippet Test Fixture",
        "",
        "```ts",
        "export const snippet = 1;",
        "```",
      ].join("\\n");
    });

    const desktopPage = await desktopContext.newPage();
    const mobilePage = await mobileContext.newPage();

    const detectHardFailures = async (page: import("playwright").Page, route: string, viewport: "desktop" | "mobile"): Promise<string[]> => {
      const failures: string[] = [];
      const overlay = await page
        .evaluate(() => {
          const text = (document.body?.innerText ?? "").toLowerCase();
          if (text.includes("client-side exception") || text.includes("application error")) return "nextjs client exception overlay";
          if (text.includes("error:") && text.includes("see the browser console")) return "generic runtime error overlay";
          return null;
        })
        .catch(() => null);
      if (overlay) failures.push(overlay);

      if (viewport === "mobile") {
        const overflowDetected = await page
          .evaluate(() => {
            const html = document.documentElement;
            return html.scrollWidth - html.clientWidth > 2;
          })
          .catch(() => false);
        if (overflowDetected) failures.push("mobile horizontal overflow detected");
      }

      // Route-specific probes.
      // Mermaid is a first-class requirement for the guide route, but the showcase route is intentionally
      // a simple marketing-style page that may not embed an actual diagram.
      if (route.includes("docs/guides/mermaid-diagrams")) {
        const hasMermaidBlock = await page
          .evaluate(() => Boolean(document.querySelector(".stream-mdx-mermaid-block")))
          .catch(() => false);
        if (!hasMermaidBlock) {
          failures.push("mermaid block missing");
        } else {
          await page.locator(".stream-mdx-mermaid-block").first().scrollIntoViewIfNeeded().catch(() => undefined);
          await page.waitForTimeout(250);

          let hasSvg = await page
            .evaluate(() => Boolean(document.querySelector(".stream-mdx-mermaid-diagram svg")))
            .catch(() => false);

          if (!hasSvg) {
            await page
              .getByRole("button", { name: "Diagram" })
              .first()
              .click({ timeout: 1500 })
              .catch(() => undefined);
            await page.waitForTimeout(600);
            hasSvg = await page
              .evaluate(() => Boolean(document.querySelector(".stream-mdx-mermaid-diagram svg")))
              .catch(() => false);
          }

          if (!hasSvg) {
            const hasMermaidError = await page
              .evaluate(() => Boolean(document.querySelector(".stream-mdx-mermaid-error")))
              .catch(() => false);
            failures.push(hasMermaidError ? "mermaid render error" : "mermaid svg missing");
          }
        }
      }

      if (route.startsWith("/docs/") && route !== "/docs/" && route !== "/docs") {
        const tocLayout = await page
          .evaluate((input) => {
            const asides = Array.from(document.querySelectorAll("aside"));
            const tocAside = asides.find((aside) => (aside.textContent ?? "").toLowerCase().includes("on this page"));
            if (!tocAside) return null;
            const asHtml = tocAside as HTMLElement;
            const visible = asHtml.offsetParent !== null && getComputedStyle(asHtml).visibility !== "hidden";
            if (input.viewport === "mobile") {
              return visible ? "on-this-page aside should be hidden on mobile" : null;
            }
            if (!visible) return "on-this-page aside missing on desktop";
            const heading = document.querySelector("#article-content-wrapper h1, article h1, main h1") as HTMLElement | null;
            if (!heading) return null;
            const a = heading.getBoundingClientRect();
            const t = asHtml.getBoundingClientRect();
            const intersects =
              Math.max(0, Math.min(a.right, t.right) - Math.max(a.left, t.left)) > 0 &&
              Math.max(0, Math.min(a.bottom, t.bottom) - Math.max(a.top, t.top)) > 0;
            if (intersects) return "on-this-page aside overlaps article heading";
            return null;
          }, { viewport })
          .catch(() => null);
        if (tocLayout) failures.push(tocLayout);

        if (viewport === "mobile") {
          const mobileNav = await page
            .evaluate(() => {
              const details = Array.from(document.querySelectorAll("details")).find((node) =>
                (node.querySelector("summary")?.textContent ?? "").toLowerCase().includes("browse docs"),
              ) as HTMLDetailsElement | undefined;
              if (!details) return "mobile docs nav toggle missing";
              const summary = details.querySelector("summary") as HTMLElement | null;
              if (!summary) return "mobile docs nav summary missing";

              summary.click();
              const opened = details.open;
              if (!opened) return "mobile docs nav did not open";

              const linkCount = details.querySelectorAll("a[href]").length;
              if (linkCount < 3) return "mobile docs nav opened with insufficient links";

              summary.click();
              return null;
            })
            .catch(() => "mobile docs nav probe failed");
          if (mobileNav) failures.push(mobileNav);
        }
      }

      return failures;
    };

    const waitForRouteReady = async (page: import("playwright").Page, route: string) => {
      // Always apply capture CSS as early as we can after navigation.
      await ensureCaptureStyles(page);

      // Route-specific stability probes. Keep these conservative: they should be true for both snapshot and streaming modes.
      if (route === "/") {
        await page.waitForSelector("main h1", { timeout: 12000 });
        await page.waitForFunction(() => {
          const h1 = document.querySelector<HTMLElement>("main h1");
          if (!h1) return false;
          const style = window.getComputedStyle(h1);
          return style.opacity !== "0" && style.visibility !== "hidden" && h1.offsetHeight > 0;
        }, { timeout: 12000 });
        await page.waitForFunction(() => {
          const main = document.querySelector<HTMLElement>("main");
          return Boolean(main && (main.innerText ?? "").trim().length >= 40);
        }, { timeout: 12000 });
        return;
      }

      if (route === "/regression/html") {
        await page.waitForSelector("#regression-root", { timeout: 12000, state: "attached" });
        await page.waitForFunction(() => Boolean((window as any).__streammdxRegression), { timeout: 15000 });
        await page
          .evaluate(async () => {
            const api = (window as any).__streammdxRegression;
            if (!api) return;
            api.restart();
            await api.waitForReady();
            await api.appendAndFlush(
              [
                "# Regression Fixture",
                "",
                "A table:",
                "",
                "| a | b |",
                "|---|---|",
                "| 1 | 2 |",
                "",
                "```ts",
                "export const x = 1;",
                "```",
              ].join("\\n"),
            );
            await api.finalizeAndFlush();
          })
          .catch(() => undefined);
        await page
          .waitForFunction(() => {
            const root = document.getElementById("regression-root");
            const text = (root?.textContent ?? "").trim();
            return text.length > 80;
          }, { timeout: 20000 })
          .catch(() => undefined);
        return;
      }

      if (route === "/regression/snippet-test") {
        await page.waitForSelector("main h1, h1", { timeout: 12000 });
        return;
      }

      // Docs/articles/showcase routes should have an article wrapper.
      await page.waitForSelector("#article-content-wrapper, article, main h1", { timeout: 12000 });
      await page.waitForFunction(() => {
        const el = document.querySelector<HTMLElement>("#article-content-wrapper, article, main h1");
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.opacity !== "0" && style.visibility !== "hidden" && el.offsetHeight > 0;
      }, { timeout: 12000 });
    };

    const hasVisibleArticleContent = async (page: import("playwright").Page) => {
      return await page
        .evaluate(() => {
          const regressionRoot = document.getElementById("regression-root") as HTMLElement | null;
          if (regressionRoot) {
            const text = (regressionRoot.innerText ?? "").trim();
            return text.length >= 80;
          }
          const wrapper = document.querySelector<HTMLElement>("#article-content-wrapper");
          if (wrapper) {
            const text = (wrapper.innerText ?? "").trim();
            return text.length >= 120;
          }
          const main = document.querySelector<HTMLElement>("main");
          return Boolean(main && (main.innerText ?? "").trim().length >= 80);
        })
        .catch(() => false);
    };

    const navigateWithRetries = async (
      page: import("playwright").Page,
      url: string,
      route: string,
      attempts = 3,
    ): Promise<void> => {
      let lastError: unknown = null;
      for (let i = 0; i < attempts; i += 1) {
        try {
          await page.goto(url, { waitUntil: "domcontentloaded" });
          await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
          await page.waitForTimeout(WAIT_AFTER_LOAD_MS);
          await waitForRouteReady(page, route);
          if (await hasVisibleArticleContent(page)) return;
          throw new Error("content probe: mostly blank");
        } catch (err) {
          lastError = err;
          // Hard reload before retrying.
          await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
          await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    };

    for (const route of routes) {
      const filename = routeToFilename(route);
      const desktopPath = path.join(OUTPUT_DIR, `desktop__${filename}.png`);
      const mobilePath = path.join(OUTPUT_DIR, `mobile__${filename}.png`);
      const url = `${BASE_URL}${route}`;

      try {
        process.stdout.write(`[capture] desktop ${route}\n`);
        desktopPage.setDefaultNavigationTimeout(60000);
        const consoleErrors: string[] = [];
        const onConsole = (msg: import("playwright").ConsoleMessage) => {
          if (msg.type() === "error") consoleErrors.push(msg.text());
        };
        desktopPage.on("console", onConsole);
        await navigateWithRetries(desktopPage, url, route);
        const hardFailures = await detectHardFailures(desktopPage, route, "desktop");
        await desktopPage.screenshot({ path: desktopPath, fullPage: FULL_PAGE });
        desktopPage.off("console", onConsole);
        const filteredConsoleErrors = consoleErrors.filter((entry) => !isAllowedConsoleError(entry));
        const combinedErrors = [
          ...(FAIL_ON_CONSOLE ? filteredConsoleErrors : []),
          ...(FAIL_ON_OVERLAY ? hardFailures : []),
        ].filter((e) => typeof e === "string" && e.trim().length > 0);
        if (combinedErrors.length > 0) errorsByRoute.push({ route, viewport: "desktop", errors: combinedErrors });
      } catch (error) {
        console.error(`[capture] desktop failed for ${route}:`, error);
        if (FAIL_ON_ERRORS) {
          errorsByRoute.push({ route, viewport: "desktop", errors: [String((error as Error)?.message ?? error)] });
        }
      }

      try {
        process.stdout.write(`[capture] mobile  ${route}\n`);
        mobilePage.setDefaultNavigationTimeout(60000);
        const consoleErrors: string[] = [];
        const onConsole = (msg: import("playwright").ConsoleMessage) => {
          if (msg.type() === "error") consoleErrors.push(msg.text());
        };
        mobilePage.on("console", onConsole);
        await navigateWithRetries(mobilePage, url, route);
        const hardFailures = await detectHardFailures(mobilePage, route, "mobile");
        await mobilePage.screenshot({ path: mobilePath, fullPage: FULL_PAGE });
        mobilePage.off("console", onConsole);
        const filteredConsoleErrors = consoleErrors.filter((entry) => !isAllowedConsoleError(entry));
        const combinedErrors = [
          ...(FAIL_ON_CONSOLE ? filteredConsoleErrors : []),
          ...(FAIL_ON_OVERLAY ? hardFailures : []),
        ].filter((e) => typeof e === "string" && e.trim().length > 0);
        if (combinedErrors.length > 0) errorsByRoute.push({ route, viewport: "mobile", errors: combinedErrors });
      } catch (error) {
        console.error(`[capture] mobile failed for ${route}:`, error);
        if (FAIL_ON_ERRORS) {
          errorsByRoute.push({ route, viewport: "mobile", errors: [String((error as Error)?.message ?? error)] });
        }
      }
    }

    await desktopContext.close();
    await mobileContext.close();
  } finally {
    await browser.close();
  }

  writeManifest();

  if (FAIL_ON_ERRORS && errorsByRoute.length > 0) {
    throw new Error(`[capture] failures detected: ${errorsByRoute.length} (see ${manifestPath})`);
  }
}

async function main() {
  prepareCapturePrerequisites();
  if (MANIFEST_ONLY) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    await captureScreenshots();
    return;
  }
  const { stop } = startDevServer();
  try {
    await waitForServer(`${BASE_URL}/`);
    await captureScreenshots();
  } finally {
    await stop();
  }
}

main().catch((error) => {
  console.error("[capture] failed", error);
  process.exit(1);
});
