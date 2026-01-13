import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

import { chromium } from "@playwright/test";

import { getFixtures, loadScenarioFiles, readFixtureFile, splitMarkers, buildChunks, progressCheckpoints, shouldRunScenario, isSplitScenario } from "./utils";
import type { RegressionScenario } from "./utils";

const UPDATE = process.env.UPDATE_SNAPSHOTS === "1" || process.env.UPDATE_SNAPSHOTS === "true";
const BASE_URL = process.env.STREAM_MDX_REGRESSION_BASE_URL || "http://localhost:3000";
const SNAPSHOT_ROOT = path.resolve(process.cwd(), "tests/regression/snapshots/html");
const ARTIFACT_ROOT = path.resolve(process.cwd(), "tests/regression/artifacts");

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function firstDiffIndex(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  if (a.length !== b.length) return len;
  return -1;
}

function diffContext(value: string, index: number, span = 80): string {
  if (index < 0) return "";
  const start = Math.max(0, index - span);
  const end = Math.min(value.length, index + span);
  return value.slice(start, end);
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readSummary(
  page: import("@playwright/test").Page,
): Promise<{ rootChildCount: number; selectors: Record<string, boolean>; counts?: Record<string, number> }> {
  const summary = (await page.evaluate(() => window.__streammdxRegression?.getSummary())) as
    | { rootChildCount: number; selectors: Record<string, boolean>; counts?: Record<string, number> }
    | undefined;
  if (summary) return summary;
  await page.waitForFunction(() => Boolean(window.__streammdxRegression));
  const retry = (await page.evaluate(() => window.__streammdxRegression?.getSummary())) as
    | { rootChildCount: number; selectors: Record<string, boolean>; counts?: Record<string, number> }
    | undefined;
  if (!retry) {
    throw new Error("Regression summary unavailable (window.__streammdxRegression missing).");
  }
  return retry;
}

type SnapshotCheckpoint = {
  id: string;
  appendedChars: number;
  rootChildCount: number;
  selectors: Record<string, boolean>;
  counts?: Record<string, number>;
  html: string;
  textSample?: string;
  structure?: {
    topLevelTags: string[];
    counts: Record<string, number>;
  };
};

type HtmlSnapshot = {
  fixtureId: string;
  fixtureTitle: string;
  scenarioId: string;
  scenario: RegressionScenario;
  totalLength: number;
  checkpoints: SnapshotCheckpoint[];
  final: {
    id: string;
    appendedChars: number;
    rootChildCount: number;
    selectors: Record<string, boolean>;
    html: string;
    structure?: {
      topLevelTags: string[];
      counts: Record<string, number>;
    };
    children?: Array<{
      index: number;
      tag: string;
      hash: string;
      textSample: string;
    }>;
  };
};

async function writeSnapshot(snapshotPath: string, data: HtmlSnapshot): Promise<void> {
  await ensureDir(path.dirname(snapshotPath));
  await fs.writeFile(snapshotPath, JSON.stringify(data, null, 2));
}

async function loadSnapshot(snapshotPath: string): Promise<HtmlSnapshot | null> {
  try {
    const raw = await fs.readFile(snapshotPath, "utf8");
    return JSON.parse(raw) as HtmlSnapshot;
  } catch {
    return null;
  }
}

function compareSnapshots(expected: HtmlSnapshot, received: HtmlSnapshot): { ok: boolean; message?: string } {
  if (expected.checkpoints.length !== received.checkpoints.length) {
    return { ok: false, message: `Checkpoint count mismatch: expected ${expected.checkpoints.length}, got ${received.checkpoints.length}` };
  }

  for (let i = 0; i < expected.checkpoints.length; i += 1) {
    const exp = expected.checkpoints[i];
    const rec = received.checkpoints[i];
    if (exp.id !== rec.id) {
      return { ok: false, message: `Checkpoint id mismatch at index ${i}: expected ${exp.id}, got ${rec.id}` };
    }
    if (exp.html !== rec.html) {
      const index = firstDiffIndex(exp.html, rec.html);
      const expectedContext = diffContext(exp.html, index);
      const receivedContext = diffContext(rec.html, index);
      return {
        ok: false,
        message: [
          `HTML mismatch at checkpoint ${exp.id}`,
          `first diff index: ${index}`,
          `expected context: ${expectedContext}`,
          `received context: ${receivedContext}`,
        ].join("\n"),
      };
    }
    if (exp.structure && rec.structure) {
      const expStructure = JSON.stringify(exp.structure);
      const recStructure = JSON.stringify(rec.structure);
      if (expStructure !== recStructure) {
        return {
          ok: false,
          message: [
            `Structure mismatch at checkpoint ${exp.id}`,
            `expected: ${expStructure}`,
            `received: ${recStructure}`,
          ].join("\n"),
        };
      }
    }
  }

  if (expected.final.structure && received.final.structure) {
    const expStructure = JSON.stringify(expected.final.structure);
    const recStructure = JSON.stringify(received.final.structure);
    if (expStructure !== recStructure) {
      return {
        ok: false,
        message: [
          "Final structure mismatch",
          `expected: ${expStructure}`,
          `received: ${recStructure}`,
        ].join("\n"),
      };
    }
  }

  if (expected.final.children && received.final.children) {
    const expChildren = expected.final.children;
    const recChildren = received.final.children;
    const len = Math.min(expChildren.length, recChildren.length);
    for (let i = 0; i < len; i += 1) {
      if (expChildren[i]?.hash !== recChildren[i]?.hash) {
        return {
          ok: false,
          message: [
            "Final root child mismatch",
            `child index: ${i}`,
            `expected: ${expChildren[i]?.tag} ${expChildren[i]?.hash} ${expChildren[i]?.textSample ?? ""}`,
            `received: ${recChildren[i]?.tag} ${recChildren[i]?.hash} ${recChildren[i]?.textSample ?? ""}`,
          ].join("\n"),
        };
      }
    }
    if (expChildren.length !== recChildren.length) {
      return {
        ok: false,
        message: [
          "Final root child count mismatch",
          `expected: ${expChildren.length}`,
          `received: ${recChildren.length}`,
        ].join("\n"),
      };
    }
  }

  if (expected.final.html !== received.final.html) {
    const index = firstDiffIndex(expected.final.html, received.final.html);
    const expectedContext = diffContext(expected.final.html, index);
    const receivedContext = diffContext(received.final.html, index);
    return {
      ok: false,
      message: [
        `Final HTML mismatch`,
        `first diff index: ${index}`,
        `expected context: ${expectedContext}`,
        `received context: ${receivedContext}`,
      ].join("\n"),
    };
  }

  return { ok: true };
}

function hashHtml(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function readRootText(page: import("@playwright/test").Page): Promise<string> {
  return await page.evaluate(() => {
    const root = document.getElementById("regression-root");
    return root?.textContent ?? "";
  });
}

async function readStructure(page: import("@playwright/test").Page): Promise<{ topLevelTags: string[]; counts: Record<string, number> }> {
  return await page.evaluate(() => {
    const root = document.getElementById("regression-root");
    const topLevelTags = root ? Array.from(root.children).map((child) => child.tagName.toLowerCase()) : [];
    const counts: Record<string, number> = {
      table: root?.querySelectorAll("table").length ?? 0,
      pre: root?.querySelectorAll("pre").length ?? 0,
      blockquote: root?.querySelectorAll("blockquote").length ?? 0,
      katex: root?.querySelectorAll(".katex").length ?? 0,
      mdxPending: root?.querySelectorAll('.markdown-mdx[data-mdx-status="pending"]').length ?? 0,
      mdxCompiled: root?.querySelectorAll('.markdown-mdx[data-mdx-status="compiled"]').length ?? 0,
      footnotes: root?.querySelectorAll(".footnotes").length ?? 0,
      hr: root?.querySelectorAll("hr").length ?? 0,
    };
    return { topLevelTags, counts };
  });
}

async function readRootChildren(page: import("@playwright/test").Page): Promise<Array<{ tag: string; html: string; text: string }>> {
  return await page.evaluate(() => {
    const root = document.getElementById("regression-root");
    if (!root) return [];
    return Array.from(root.children).map((child) => ({
      tag: child.tagName.toLowerCase(),
      html: child.outerHTML,
      text: (child.textContent ?? "").slice(0, 120),
    }));
  });
}

async function run(): Promise<void> {
  const fixtureFilter = getArg("--filter");
  const scenarioFilter = getArg("--scenario");

  const fixtures = getFixtures().filter((fixture) => (fixtureFilter ? fixture.id.includes(fixtureFilter) : true));
  const scenarios = (await loadScenarioFiles()).filter((scenario) => (scenarioFilter ? scenario.id.includes(scenarioFilter) : true));

  if (fixtures.length === 0) {
    console.error("No fixtures matched filter.");
    process.exitCode = 1;
    return;
  }
  if (scenarios.length === 0) {
    console.error("No scenarios matched filter.");
    process.exitCode = 1;
    return;
  }

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const suppressedConsole = {
    nameNotResolved: 0,
    nameNotResolvedByFixture: {} as Record<string, number>,
  };
  const ignored404Patterns = ["/favicon.ico", "/robots.txt", "/apple-touch-icon", "/site.webmanifest"];
  const unexpected404Urls = new Set<string>();
  let suppressNameNotResolved = false;
  let currentFixtureId = "unknown";
  page.on("pageerror", (error) => {
    console.error(`\n[regression pageerror] ${error}`);
  });
  page.on("response", (response) => {
    if (response.status() !== 404) return;
    const url = response.url();
    if (ignored404Patterns.some((pattern) => url.includes(pattern))) {
      return;
    }
    if (unexpected404Urls.has(url)) {
      return;
    }
    unexpected404Urls.add(url);
    console.error(`\n[regression http404] ${url}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      const text = message.text();
      if (text.includes("Failed to load resource: the server responded with a status of 404")) {
        return;
      }
      if (text.includes("net::ERR_NAME_NOT_RESOLVED") && suppressNameNotResolved) {
        suppressedConsole.nameNotResolved += 1;
        suppressedConsole.nameNotResolvedByFixture[currentFixtureId] =
          (suppressedConsole.nameNotResolvedByFixture[currentFixtureId] ?? 0) + 1;
        return;
      }
      console.error(`\n[regression console.${message.type()}] ${text}`);
    }
  });

  let failures = 0;

  for (const fixture of fixtures) {
    currentFixtureId = fixture.id;
    suppressNameNotResolved = (fixture.tags ?? []).includes("mdx");
    const enforcePrefixInvariant = (fixture.tags ?? []).includes("prefix-safe");
    const rawContent = await readFixtureFile(fixture.file);

    for (const scenario of scenarios) {
      if (!shouldRunScenario(fixture, scenario)) continue;
      let scenarioFailed = false;

      const split = splitMarkers(rawContent);
      const text = split ? split.text : rawContent;
      const chunks = isSplitScenario(scenario) && split ? split.chunks : buildChunks(text, scenario);
      const tableTargetPct = fixture.expectTableByPct;
      const tableTargetChars =
        typeof tableTargetPct === "number" && scenario.maxChunkChars <= 512
          ? Math.max(1, Math.round(text.length * tableTargetPct))
          : null;

      const progressTargets = progressCheckpoints(text.length);
      const checkpointTargets = [...progressTargets];
      const checkpointSet = new Set<number>();

      const seenEvents: Record<string, boolean> = {
        hasTable: false,
        hasPre: false,
        hasFootnotes: false,
        hasMdxPending: false,
        hasMdxCompiled: false,
        hasBlockquote: false,
        hasMath: false,
      };

      const checkpoints: SnapshotCheckpoint[] = [];

      await page.goto(`${BASE_URL}/regression/html/`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => Boolean(window.__streammdxRegression));
      await page.evaluate(
        ({ fixtureId, scenarioId }) => window.__streammdxRegression?.setMeta({ fixtureId, scenarioId }),
        { fixtureId: fixture.id, scenarioId: scenario.id },
      );
      await page.evaluate(() => window.__streammdxRegression?.waitForReady());

      let appended = 0;
      let firstChunkCaptured = false;
      let tableFirstSeenAt: number | null = null;
      let lastCheckpointText = "";
      let lastCheckpointChildCount = 0;
      const streamInvariantFailures: string[] = [];

      for (const chunk of chunks) {
        await page.evaluate((value) => window.__streammdxRegression?.appendAndFlush(value), chunk);
        appended += chunk.length;

        const summary = await readSummary(page);
        if (tableFirstSeenAt === null && summary.selectors.hasTable) {
          tableFirstSeenAt = appended;
        }
        if (summary.counts?.table && tableFirstSeenAt === null) {
          tableFirstSeenAt = appended;
        }

        if (!firstChunkCaptured) {
          const html = await page.evaluate(() => window.__streammdxRegression?.getHtml());
          const structure = await readStructure(page);
          const textContent = await readRootText(page);
          if (enforcePrefixInvariant && !summary.selectors.hasMdxPending && lastCheckpointText && !textContent.startsWith(lastCheckpointText)) {
            streamInvariantFailures.push(`text prefix invariant failed at after-first-chunk (${fixture.id}/${scenario.id})`);
          }
          if (summary.rootChildCount < lastCheckpointChildCount) {
            streamInvariantFailures.push(
              `root child count decreased at after-first-chunk (${lastCheckpointChildCount} -> ${summary.rootChildCount})`,
            );
          }
          lastCheckpointText = textContent;
          lastCheckpointChildCount = summary.rootChildCount;
          checkpoints.push({
            id: "after-first-chunk",
            appendedChars: appended,
            rootChildCount: summary.rootChildCount,
            selectors: summary.selectors,
            counts: summary.counts,
            html: html ?? "",
            textSample: textContent.slice(0, 200),
            structure,
          });
          firstChunkCaptured = true;
        }

        while (checkpointTargets.length > 0 && appended >= checkpointTargets[0]) {
          const target = checkpointTargets.shift();
          if (target !== undefined && !checkpointSet.has(target)) {
            checkpointSet.add(target);
            const html = await page.evaluate(() => window.__streammdxRegression?.getHtml());
            const structure = await readStructure(page);
            const textContent = await readRootText(page);
            if (enforcePrefixInvariant && !summary.selectors.hasMdxPending && lastCheckpointText && !textContent.startsWith(lastCheckpointText)) {
              streamInvariantFailures.push(`text prefix invariant failed at progress-${target} (${fixture.id}/${scenario.id})`);
            }
            if (summary.rootChildCount < lastCheckpointChildCount) {
              streamInvariantFailures.push(
                `root child count decreased at progress-${target} (${lastCheckpointChildCount} -> ${summary.rootChildCount})`,
              );
            }
            lastCheckpointText = textContent;
            lastCheckpointChildCount = summary.rootChildCount;
            checkpoints.push({
              id: `progress-${target}`,
              appendedChars: appended,
              rootChildCount: summary.rootChildCount,
              selectors: summary.selectors,
              counts: summary.counts,
              html: html ?? "",
              textSample: textContent.slice(0, 200),
              structure,
            });
          }
        }

        for (const [key, value] of Object.entries(summary.selectors)) {
          if (value && !seenEvents[key]) {
            seenEvents[key] = true;
            const html = await page.evaluate(() => window.__streammdxRegression?.getHtml());
            const structure = await readStructure(page);
            const textContent = await readRootText(page);
            if (enforcePrefixInvariant && !summary.selectors.hasMdxPending && lastCheckpointText && !textContent.startsWith(lastCheckpointText)) {
              streamInvariantFailures.push(`text prefix invariant failed at event-${key} (${fixture.id}/${scenario.id})`);
            }
            if (summary.rootChildCount < lastCheckpointChildCount) {
              streamInvariantFailures.push(
                `root child count decreased at event-${key} (${lastCheckpointChildCount} -> ${summary.rootChildCount})`,
              );
            }
            lastCheckpointText = textContent;
            lastCheckpointChildCount = summary.rootChildCount;
            checkpoints.push({
              id: `event-${key}`,
              appendedChars: appended,
              rootChildCount: summary.rootChildCount,
              selectors: summary.selectors,
              counts: summary.counts,
              html: html ?? "",
              textSample: textContent.slice(0, 200),
              structure,
            });
          }
        }
      }

      await page.evaluate(() => window.__streammdxRegression?.finalizeAndFlush());

      if (fixture.tags?.includes("mdx")) {
        try {
          await page.waitForFunction(() => {
            const summary = window.__streammdxRegression?.getSummary();
            if (!summary) return false;
            return summary.selectors.hasMdxCompiled && !summary.selectors.hasMdxPending;
          });
        } catch (error) {
          failures += 1;
          scenarioFailed = true;
          console.error(`\nMDX compile timeout for ${fixture.id}/${scenario.id}`);
          console.error(error);
        }
      }

      const invariantViolations = (await page.evaluate(
        () => window.__streammdxRegression?.getInvariantViolations?.() ?? [],
      )) as { message: string }[];
      if (streamInvariantFailures.length > 0) {
        failures += 1;
        scenarioFailed = true;
        console.error(`\nStreaming invariant violations for ${fixture.id}/${scenario.id}:`);
        for (const message of streamInvariantFailures) {
          console.error(`- ${message}`);
        }
      }
      if (invariantViolations.length > 0) {
        failures += 1;
        scenarioFailed = true;
        console.error(`\nInvariant violations for ${fixture.id}/${scenario.id}:`);
        for (const violation of invariantViolations) {
          console.error(`- ${violation.message}`);
        }
      }

      const finalSummary = (await page.evaluate(() => window.__streammdxRegression?.getSummary())) as {
        rootChildCount: number;
        selectors: Record<string, boolean>;
        counts?: Record<string, number>;
      };
      const finalHtml = await page.evaluate(() => window.__streammdxRegression?.getHtml());
      const finalStructure = await readStructure(page);
      const rootChildren = await readRootChildren(page);
      const childHashes = rootChildren.map((child, index) => ({
        index,
        tag: child.tag,
        hash: hashHtml(child.html),
        textSample: child.text,
      }));
      const htmlInvariantFailures: string[] = [];
      const finalHtmlValue = finalHtml ?? "";
      const rawBlockMathNeedle = '<p class="markdown-paragraph">$$';
      const rawInlineCodeNeedle =
        "`this is a really really really really really really really really really really really really really really really really really really really really really long inline code span`";
      const emptyListNeedle =
        '<div class="markdown-list-item-children"><ul class="markdown-list unordered" data-list-depth="1"></ul></div>';
      const isSanitizationFixture = (fixture.tags ?? []).includes("sanitization");

      if (finalHtmlValue.includes(rawBlockMathNeedle)) {
        htmlInvariantFailures.push("raw block math detected in paragraph (expected KaTeX output).");
      }
      if (finalHtmlValue.includes(rawInlineCodeNeedle)) {
        htmlInvariantFailures.push("raw backtick inline code detected (expected <code> output).");
      }
      if (finalHtmlValue.includes(emptyListNeedle)) {
        htmlInvariantFailures.push("empty nested list container detected.");
      }
      if (isSanitizationFixture) {
        if (finalHtmlValue.includes("<script")) {
          htmlInvariantFailures.push("sanitization failure: <script> tag present.");
        }
        if (finalHtmlValue.includes("onerror=")) {
          htmlInvariantFailures.push("sanitization failure: onerror attribute present.");
        }
        if (finalHtmlValue.includes("onclick=")) {
          htmlInvariantFailures.push("sanitization failure: onclick attribute present.");
        }
      }
      if (tableTargetChars !== null) {
        if (tableFirstSeenAt === null || tableFirstSeenAt > tableTargetChars) {
          htmlInvariantFailures.push(
            `table was not visible by ${Math.round(tableTargetPct! * 100)}% (first seen at ${tableFirstSeenAt ?? "never"} / ${tableTargetChars} chars).`,
          );
        }
      }
      if (htmlInvariantFailures.length > 0) {
        failures += 1;
        scenarioFailed = true;
        console.error(`\nHTML invariant violations for ${fixture.id}/${scenario.id}:`);
        for (const message of htmlInvariantFailures) {
          console.error(`- ${message}`);
        }
      }

      const requiredSelectors = fixture.requiredSelectors ?? [];
      if (requiredSelectors.length > 0) {
        const missing = (await page.evaluate((selectors) => {
          const root = document.getElementById("regression-root");
          if (!root) return selectors;
          return selectors.filter((selector) => !root.querySelector(selector));
        }, requiredSelectors)) as string[];
        if (missing.length > 0) {
          failures += 1;
          scenarioFailed = true;
          console.error(`\nMissing required selectors for ${fixture.id}/${scenario.id}: ${missing.join(", ")}`);
        }
      }

      const snapshot: HtmlSnapshot = {
        fixtureId: fixture.id,
        fixtureTitle: fixture.title,
        scenarioId: scenario.id,
        scenario,
        totalLength: text.length,
        checkpoints,
        final: {
          id: "after-finalize",
          appendedChars: appended,
          rootChildCount: finalSummary.rootChildCount,
          selectors: finalSummary.selectors,
          html: finalHtml ?? "",
          structure: finalStructure,
          children: childHashes,
        },
      };

      const snapshotPath = path.join(SNAPSHOT_ROOT, fixture.id, `${scenario.id}.snap.json`);

      if (UPDATE) {
        if (scenarioFailed) {
          console.warn(`skipped update for ${fixture.id}/${scenario.id} due to failures`);
        } else {
          await writeSnapshot(snapshotPath, snapshot);
          console.log(`updated ${fixture.id}/${scenario.id}`);
        }
        continue;
      }

      const expected = await loadSnapshot(snapshotPath);
      if (!expected) {
        console.error(`missing snapshot for ${fixture.id}/${scenario.id}`);
        failures += 1;
        continue;
      }

      const result = compareSnapshots(expected, snapshot);
      if (!result.ok) {
        failures += 1;
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const artifactDir = path.join(ARTIFACT_ROOT, stamp, fixture.id, scenario.id);
        await ensureDir(artifactDir);
        await fs.writeFile(path.join(artifactDir, "expected.html"), expected.final.html);
        await fs.writeFile(path.join(artifactDir, "received.html"), snapshot.final.html);
        console.error(`\nHTML regression: ${fixture.id} / ${scenario.id}\n${result.message}\n`);
        console.error(`artifacts: ${artifactDir}`);
      } else {
        console.log(`ok ${fixture.id}/${scenario.id}`);
      }
    }
  }

  await page.close();
  await context.close();
  await browser.close();

  if (suppressedConsole.nameNotResolved > 0) {
    const details = Object.entries(suppressedConsole.nameNotResolvedByFixture)
      .map(([fixtureId, count]) => `${fixtureId}=${count}`)
      .join(", ");
    const suffix = details ? ` (${details})` : "";
    console.warn(
      `[regression console] suppressed ${suppressedConsole.nameNotResolved} net::ERR_NAME_NOT_RESOLVED errors${suffix}`,
    );
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
