import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

const PLACEHOLDER_MARKERS = [
  "this page is a placeholder",
  "placeholder for a richer feature showcase article",
  "coming soon",
  "todo",
];

function isIgnorableConsoleError(message: string) {
  const lower = message.toLowerCase();
  return (
    lower.includes("a tree hydrated but some attributes of the server rendered html didn't match") &&
    lower.includes("caret-color") &&
    lower.includes("hydration-mismatch")
  );
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

type RouteResult = {
  route: string;
  url: string;
  title: string;
  status: number;
  mainTextLength: number;
  tocCount: number;
  has404Text: boolean;
  placeholderHits: string[];
};

async function main() {
  const baseUrl = (process.env.DOCS_AUDIT_BASE_URL ?? "http://127.0.0.1:3006").replace(/\/$/, "");
  const evidenceDir = process.env.DOCS_AUDIT_EVIDENCE_DIR ?? path.join("tmp", "docs-quality-audit", timestamp());
  await fs.mkdir(evidenceDir, { recursive: true });

  const criticalRoutes = [
    "/",
    "/demo/",
    "/docs/",
    "/docs/getting-started/",
    "/docs/public-api/",
    "/docs/tui-json-protocol/",
    "/docs/manual/",
    "/docs/guides/mermaid-diagrams/",
    "/showcase/",
    "/showcase/html-overrides/",
  ];

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.setDefaultNavigationTimeout(90_000);

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (isIgnorableConsoleError(text)) return;
    consoleErrors.push(text);
  });
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const results: RouteResult[] = [];
  const discoveredInternal = new Set<string>();

  try {
    for (const route of criticalRoutes) {
      const url = `${baseUrl}${route}`;
      const response = await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(250);

      const title = await page.title();
      const data = await page.evaluate(() => {
        const main = document.querySelector("main");
        const mainText = main?.textContent?.trim() ?? "";
        const tocCount = document.querySelectorAll("[aria-label='Table of contents'] button").length;
        const has404Text = /this page could not be found|404/i.test(document.body.innerText);
        const allLinks = Array.from(document.querySelectorAll("a[href]"))
          .map((anchor) => (anchor as HTMLAnchorElement).getAttribute("href") ?? "")
          .filter((href) => href.startsWith("/"))
          .filter((href) => !href.startsWith("/_next/"));
        return {
          mainTextLength: mainText.length,
          tocCount,
          has404Text,
          bodyText: document.body.innerText,
          links: allLinks,
        };
      });

      for (const href of data.links) {
        if (href.startsWith("#")) continue;
        discoveredInternal.add(href);
      }

      const normalizedBody = data.bodyText.toLowerCase();
      const placeholderHits = PLACEHOLDER_MARKERS.filter((marker) => normalizedBody.includes(marker));

      const safeName = route === "/" ? "home" : route.replaceAll("/", "_").replace(/^_+|_+$/g, "");
      await page.screenshot({ path: path.join(evidenceDir, `${safeName}.png`), fullPage: true });

      results.push({
        route,
        url,
        title,
        status: response?.status() ?? 0,
        mainTextLength: data.mainTextLength,
        tocCount: data.tocCount,
        has404Text: data.has404Text,
        placeholderHits,
      });
    }

    const sampleDiscovered = Array.from(discoveredInternal)
      .sort()
      .filter((href) => href !== "/")
      .slice(0, 40);

    const report = {
      ok: true,
      baseUrl,
      checkedAt: new Date().toISOString(),
      routesChecked: results.length,
      results,
      discoveredInternalCount: discoveredInternal.size,
      discoveredInternalSample: sampleDiscovered,
      consoleErrors,
      pageErrors,
    };

    await fs.writeFile(path.join(evidenceDir, "docs-quality-report.json"), JSON.stringify(report, null, 2));

    const badStatuses = results.filter((item) => item.status >= 400 || item.status === 0);
    const has404 = results.filter((item) => item.has404Text);
    const tooThin = results.filter((item) => item.mainTextLength < 120);

    if (badStatuses.length > 0) {
      throw new Error(`Found non-OK HTTP responses: ${badStatuses.map((item) => `${item.route}:${item.status}`).join(", ")}`);
    }
    if (has404.length > 0) {
      throw new Error(`Found 404 body content on routes: ${has404.map((item) => item.route).join(", ")}`);
    }
    if (tooThin.length > 0) {
      throw new Error(`Found thin/empty content on routes: ${tooThin.map((item) => `${item.route}:${item.mainTextLength}`).join(", ")}`);
    }
    if (consoleErrors.length > 0 || pageErrors.length > 0) {
      throw new Error(`Runtime errors detected (console=${consoleErrors.length}, page=${pageErrors.length})`);
    }

    console.log("docs-quality-audit: PASS");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await page.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
