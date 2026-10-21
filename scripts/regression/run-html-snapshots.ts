import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

import { chromium } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";

import {
  getFixtures,
  loadScenarioFiles,
  readFixtureFile,
  splitMarkers,
  buildChunks,
  buildSeededChunks,
  progressCheckpoints,
  shouldRunScenario,
  isSplitScenario,
  firstDiffIndex,
  diffContext,
  findMissingRequiredTextFragments,
} from "./utils";
import type { RegressionScenario } from "./utils";

const UPDATE = process.env.UPDATE_SNAPSHOTS === "1" || process.env.UPDATE_SNAPSHOTS === "true";
const BASE_URL = process.env.STREAM_MDX_REGRESSION_BASE_URL || "http://localhost:3000";
const SNAPSHOT_ROOT = path.resolve(process.cwd(), "tests/regression/snapshots/html");
const ARTIFACT_ROOT = path.resolve(getArg("--out") ?? path.join(process.cwd(), "tests/regression/artifacts"));

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function getNumArg(flag: string): number | null {
  const value = getArg(flag);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const SCENARIO_TIMEOUT_MS = getNumArg("--timeout") ?? Number(process.env.STREAM_MDX_REGRESSION_TIMEOUT ?? 60000);

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readSummary(
  page: Page,
  remainingTimeout: () => number,
): Promise<{ rootChildCount: number; selectors: Record<string, boolean>; counts?: Record<string, number> }> {
  const summary = (await page.evaluate(() => window.__streammdxRegression?.getSummary())) as
    | { rootChildCount: number; selectors: Record<string, boolean>; counts?: Record<string, number> }
    | undefined;
  if (summary) return summary;
  await page.waitForFunction(() => Boolean(window.__streammdxRegression), undefined, { timeout: remainingTimeout() });
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
  runtimeState?: {
    rendererVersion: number;
    queueDepth: number;
    pendingBatches: number;
    workerReady: boolean;
    workerInitialized?: boolean;
    workerFinalized?: boolean;
    workerErrors?: string[];
    harnessErrors?: string[];
    lastTx: number | null;
    lastPatchToDomMs: number | null;
    lastDurationMs: number | null;
    meta?: {
      fixtureId?: string;
      scenarioId?: string;
      seed?: string;
      schedulerMode?: string;
    };
    storeCounters?: Record<string, number>;
  };
  selectors: Record<string, boolean>;
  counts?: Record<string, number>;
  html: string;
  textSample?: string;
  structure?: {
    topLevelTags: string[];
    counts: Record<string, number>;
  };
  inspection?: RenderInspection;
};

type RenderInspection = {
  tables: Array<{
    headerColumns: number;
    rowCellCounts: number[];
    emptyBodyCellCount: number;
  }>;
  mdxBlocks: Array<{
    status: string | null;
    textSample: string;
  }>;
  codeBlocks: Array<{
    text: string;
    lineCount: number;
  }>;
};

type HtmlSnapshot = {
  fixtureId: string;
  fixtureTitle: string;
  scenarioId: string;
  scenario: RegressionScenario;
  runMeta?: {
    seed?: string | null;
    schedulerMode?: string | null;
    usedSplitMarkers: boolean;
    fixtureTags: string[];
  };
  totalLength: number;
  checkpoints: SnapshotCheckpoint[];
  final: {
    id: string;
    appendedChars: number;
    rootChildCount: number;
    selectors: Record<string, boolean>;
    html: string;
    runtimeState?: SnapshotCheckpoint["runtimeState"];
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
    inspection?: RenderInspection;
  };
};

async function writeSnapshot(
  snapshotPath: string,
  data: HtmlSnapshot,
  beforeCommit: () => void,
): Promise<void> {
  await ensureDir(path.dirname(snapshotPath));
  const temporaryPath = `${snapshotPath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(data, null, 2));
    beforeCommit();
    await fs.rename(temporaryPath, snapshotPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function loadSnapshot(snapshotPath: string): Promise<HtmlSnapshot | null> {
  try {
    const raw = await fs.readFile(snapshotPath, "utf8");
    return JSON.parse(raw) as HtmlSnapshot;
  } catch {
    return null;
  }
}

async function writeComparisonArtifacts(
  params: {
    fixtureId: string;
    scenarioId: string;
    label: string;
    expected: HtmlSnapshot;
    received: HtmlSnapshot;
    message: string;
    capturedLogs?: Array<{ type: string; message: string; timestamp: string }>;
  },
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeLabel = params.label.replace(/[^a-z0-9_-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const artifactDir = path.join(ARTIFACT_ROOT, stamp, params.fixtureId, params.scenarioId, safeLabel || "comparison");
  await ensureDir(artifactDir);
  await fs.writeFile(path.join(artifactDir, "expected.html"), params.expected.final.html);
  await fs.writeFile(path.join(artifactDir, "received.html"), params.received.final.html);
  await fs.writeFile(path.join(artifactDir, "expected.snap.json"), JSON.stringify(params.expected, null, 2));
  await fs.writeFile(path.join(artifactDir, "received.snap.json"), JSON.stringify(params.received, null, 2));
  await fs.writeFile(path.join(artifactDir, "message.txt"), `${params.message}\n`);
  if (params.received.final.runtimeState) {
    await fs.writeFile(
      path.join(artifactDir, "runtime-state.json"),
      JSON.stringify(params.received.final.runtimeState, null, 2),
    );
  }
  if (params.capturedLogs && params.capturedLogs.length > 0) {
    await fs.writeFile(path.join(artifactDir, "browser-logs.json"), JSON.stringify(params.capturedLogs, null, 2));
  }
  return artifactDir;
}

async function writeFailureArtifacts(
  params: {
    fixtureId: string;
    scenarioId: string;
    label: string;
    error?: unknown;
    message?: string;
    received?: Partial<HtmlSnapshot> | null;
    runtimeState?: unknown;
    html?: string;
    capturedLogs?: Array<{ type: string; message: string; timestamp: string }>;
  },
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeLabel = params.label.replace(/[^a-z0-9_-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const artifactDir = path.join(ARTIFACT_ROOT, stamp, params.fixtureId, params.scenarioId, safeLabel || "failure");
  await ensureDir(artifactDir);
  const errorDetails: string[] = [];
  if (params.message) errorDetails.push(params.message);
  if (params.error) {
    errorDetails.push(
      params.error instanceof Error
        ? `${params.error.name}: ${params.error.message}\n${params.error.stack ?? ""}`
        : String(params.error),
    );
  }
  await fs.writeFile(path.join(artifactDir, "error.txt"), `${errorDetails.join("\n\n")}\n`);
  if (params.html !== undefined) {
    await fs.writeFile(path.join(artifactDir, "partial.html"), params.html);
  }
  if (params.received) {
    await fs.writeFile(path.join(artifactDir, "partial.snap.json"), JSON.stringify(params.received, null, 2));
  }
  if (params.runtimeState) {
    await fs.writeFile(path.join(artifactDir, "runtime-state.json"), JSON.stringify(params.runtimeState, null, 2));
  }
  if (params.capturedLogs && params.capturedLogs.length > 0) {
    await fs.writeFile(path.join(artifactDir, "browser-logs.json"), JSON.stringify(params.capturedLogs, null, 2));
  }
  return artifactDir;
}

function compareFinalSnapshots(expected: HtmlSnapshot, received: HtmlSnapshot): { ok: boolean; message?: string } {
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
        "Final HTML mismatch",
        `expected lastTx: ${expected.final.runtimeState?.lastTx ?? "n/a"}`,
        `received lastTx: ${received.final.runtimeState?.lastTx ?? "n/a"}`,
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

type InlineStyleAttributeRange = {
  start: number;
  end: number;
  quote: "\"" | "'" | null;
};

// Keep non-style HTML bytes untouched; the page CSSOM supplies only replacement values.
function findInlineStyleAttributeRanges(html: string): InlineStyleAttributeRange[] | null {
  const ranges: InlineStyleAttributeRange[] = [];
  const isWhitespace = (character: string | undefined): boolean =>
    character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f";
  const findRawTextEnd = (from: number, tagName: string): number => {
    for (let index = from; index < html.length; index += 1) {
      if (html[index] !== "<" || html[index + 1] !== "/") continue;
      let matchesTag = true;
      for (let offset = 0; offset < tagName.length; offset += 1) {
        if (html[index + 2 + offset]?.toLowerCase() !== tagName[offset]) {
          matchesTag = false;
          break;
        }
      }
      const afterTagName = html[index + 2 + tagName.length];
      if (
        matchesTag &&
        (afterTagName === undefined || isWhitespace(afterTagName) || afterTagName === "/" || afterTagName === ">")
      ) {
        return index;
      }
    }
    return html.length;
  };

  let cursor = 0;
  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart < 0) break;
    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4);
      if (commentEnd < 0) return null;
      cursor = commentEnd + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", tagStart)) {
      const cdataEnd = html.indexOf("]]>", tagStart + 9);
      if (cdataEnd < 0) return null;
      cursor = cdataEnd + 3;
      continue;
    }
    if (html[tagStart + 1] === "!" || html[tagStart + 1] === "?") {
      let index = tagStart + 2;
      let quote: string | null = null;
      for (; index < html.length; index += 1) {
        const character = html[index];
        if (quote) {
          if (character === quote) quote = null;
        } else if (character === "\"" || character === "'") {
          quote = character;
        } else if (character === ">") {
          break;
        }
      }
      if (index >= html.length) return null;
      cursor = index + 1;
      continue;
    }
    if (html[tagStart + 1] === "/") {
      const endTagEnd = html.indexOf(">", tagStart + 2);
      if (endTagEnd < 0) return null;
      cursor = endTagEnd + 1;
      continue;
    }
    const firstTagCharacter = html[tagStart + 1];
    if (!firstTagCharacter || !/[A-Za-z]/.test(firstTagCharacter)) {
      cursor = tagStart + 1;
      continue;
    }

    let index = tagStart + 1;
    const tagNameStart = index;
    while (
      index < html.length &&
      !isWhitespace(html[index]) &&
      html[index] !== "/" &&
      html[index] !== ">"
    ) {
      index += 1;
    }
    const tagName = html.slice(tagNameStart, index).toLowerCase();
    let selfClosing = false;
    let tagEnded = false;
    while (index < html.length) {
      while (isWhitespace(html[index])) index += 1;
      if (html[index] === ">") {
        index += 1;
        tagEnded = true;
        break;
      }
      if (html[index] === "/" && html[index + 1] === ">") {
        index += 2;
        selfClosing = true;
        tagEnded = true;
        break;
      }

      const attributeNameStart = index;
      while (
        index < html.length &&
        !isWhitespace(html[index]) &&
        html[index] !== "=" &&
        html[index] !== ">"
      ) {
        index += 1;
      }
      if (index === attributeNameStart) {
        index += 1;
        continue;
      }
      const attributeName = html.slice(attributeNameStart, index).toLowerCase();
      while (isWhitespace(html[index])) index += 1;

      let valueStart = index;
      let valueEnd = index;
      let quote: InlineStyleAttributeRange["quote"] = null;
      if (html[index] === "=") {
        index += 1;
        while (isWhitespace(html[index])) index += 1;
        if (html[index] === "\"" || html[index] === "'") {
          quote = html[index] === "'" ? "'" : "\"";
          valueStart = index + 1;
          valueEnd = html.indexOf(quote, valueStart);
          if (valueEnd < 0) return null;
          index = valueEnd + 1;
        } else {
          valueStart = index;
          while (index < html.length && !isWhitespace(html[index]) && html[index] !== ">") index += 1;
          valueEnd = index;
        }
      }
      if (attributeName === "style") {
        ranges.push({ start: valueStart, end: valueEnd, quote });
      }
    }
    if (!tagEnded) return null;
    cursor = index;

    if (!selfClosing && tagName === "plaintext") return ranges;
    if (!selfClosing && ["iframe", "noembed", "noframes", "script", "style", "textarea", "title", "xmp"].includes(tagName)) {
      cursor = findRawTextEnd(cursor, tagName);
    }
  }
  return ranges;
}

async function prepareSnapshotForComparison(page: Page, snapshot: HtmlSnapshot): Promise<HtmlSnapshot> {
  const styleRanges = findInlineStyleAttributeRanges(snapshot.final.html);
  if (!styleRanges) return snapshot;

  const prepared = await page.evaluate(
    ({ html, ranges }) => {
      const cssNormalizer = {
        isCssTrivia(declaration: string): boolean {
          let index = 0;
          while (index < declaration.length) {
            if (
              declaration[index] === " " ||
              declaration[index] === "\t" ||
              declaration[index] === "\n" ||
              declaration[index] === "\r" ||
              declaration[index] === "\f"
            ) {
              index += 1;
            } else if (declaration[index] === "/" && declaration[index + 1] === "*") {
              const commentEnd = declaration.indexOf("*/", index + 2);
              if (commentEnd < 0) return false;
              index = commentEnd + 2;
            } else {
              return false;
            }
          }
          return true;
        },
        splitCssDeclarations(value: string): string[] | null {
          const declarations: string[] = [];
          let start = 0;
          let quote: string | null = null;
          let inComment = false;
          let parentheses = 0;
          let brackets = 0;
          let braces = 0;
          for (let index = 0; index < value.length; index += 1) {
            const character = value[index];
            const nextCharacter = value[index + 1];
            if (inComment) {
              if (character === "*" && nextCharacter === "/") {
                inComment = false;
                index += 1;
              }
              continue;
            }
            if (quote) {
              if (character === "\\") {
                index += 1;
              } else if (character === quote) {
                quote = null;
              }
              continue;
            }
            if (character === "/" && nextCharacter === "*") {
              inComment = true;
              index += 1;
            } else if (character === "\"" || character === "'") {
              quote = character;
            } else if (character === "\\") {
              index += 1;
            } else if (character === "(") {
              parentheses += 1;
            } else if (character === ")") {
              if (parentheses === 0) return null;
              parentheses -= 1;
            } else if (character === "[") {
              brackets += 1;
            } else if (character === "]") {
              if (brackets === 0) return null;
              brackets -= 1;
            } else if (character === "{") {
              braces += 1;
            } else if (character === "}") {
              if (braces === 0) return null;
              braces -= 1;
            } else if (character === ";" && parentheses === 0 && brackets === 0 && braces === 0) {
              declarations.push(value.slice(start, index));
              start = index + 1;
            }
          }
          if (quote || inComment || parentheses !== 0 || brackets !== 0 || braces !== 0) return null;
          declarations.push(value.slice(start));
          return declarations;
        },
        // Unsupported, duplicate, or lossy declarations stay byte-for-byte unchanged.
        canonicalizeStyle(value: string): string | null {
          const declarations = this.splitCssDeclarations(value);
          if (!declarations) return null;

          const propertyNames: string[] = [];
          const propertyValues: string[] = [];
          const priorities: string[] = [];
          const seenProperties = new Set<string>();
          for (const declaration of declarations) {
            if (this.isCssTrivia(declaration)) continue;
            const parsedDeclaration = document.createElement("span");
            parsedDeclaration.setAttribute("style", declaration);
            if (parsedDeclaration.style.length !== 1) return null;
            const propertyName = parsedDeclaration.style.item(0);
            if (!propertyName) return null;
            const propertyKey = propertyName.startsWith("--") ? propertyName : propertyName.toLowerCase();
            if (seenProperties.has(propertyKey)) return null;
            seenProperties.add(propertyKey);
            propertyNames.push(propertyName);
            propertyValues.push(parsedDeclaration.style.getPropertyValue(propertyName));
            priorities.push(parsedDeclaration.style.getPropertyPriority(propertyName));
          }
          if (propertyNames.length === 0) return null;

          const parsedStyle = document.createElement("span");
          parsedStyle.setAttribute("style", value);
          if (parsedStyle.style.length !== propertyNames.length) return null;
          for (let index = 0; index < propertyNames.length; index += 1) {
            const expectedName = propertyNames[index];
            const expectedValue = propertyValues[index];
            const expectedPriority = priorities[index];
            if (expectedName === undefined || expectedValue === undefined || expectedPriority === undefined) return null;
            const propertyName = parsedStyle.style.item(index);
            if (
              propertyName !== expectedName ||
              parsedStyle.style.getPropertyValue(expectedName) !== expectedValue ||
              parsedStyle.style.getPropertyPriority(expectedName) !== expectedPriority
            ) {
              return null;
            }
          }

          const cssText = parsedStyle.style.cssText;
          const roundTrip = document.createElement("span");
          roundTrip.setAttribute("style", cssText);
          if (roundTrip.style.length !== propertyNames.length) return null;
          for (let index = 0; index < propertyNames.length; index += 1) {
            const expectedName = propertyNames[index];
            const expectedValue = propertyValues[index];
            const expectedPriority = priorities[index];
            if (expectedName === undefined || expectedValue === undefined || expectedPriority === undefined) return null;
            const propertyName = roundTrip.style.item(index);
            if (
              propertyName !== expectedName ||
              roundTrip.style.getPropertyValue(expectedName) !== expectedValue ||
              roundTrip.style.getPropertyPriority(expectedName) !== expectedPriority
            ) {
              return null;
            }
          }
          return cssText;
        },
        escapeAttributeValue(value: string, quote: "\"" | "'" | null): string {
          let escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
          if (quote === "'") escaped = escaped.replace(/'/g, "&#39;");
          else escaped = escaped.replace(/"/g, "&quot;");
          return escaped;
        },
      };

      const parsedRoot = document.createElement("div");
      parsedRoot.innerHTML = html;
      const styleElements = Array.from(parsedRoot.querySelectorAll("[style]"));
      if (styleElements.length !== ranges.length) return null;
      const replacements: Array<{ range: (typeof ranges)[number]; value: string }> = [];
      for (let index = 0; index < ranges.length; index += 1) {
        const styleElement = styleElements[index];
        const styleValue = styleElement?.getAttribute("style");
        if (styleElement === undefined || styleValue === null || styleValue === undefined) return null;
        const cssText = cssNormalizer.canonicalizeStyle(styleValue);
        if (cssText !== null) {
          const range = ranges[index];
          if (!range) return null;
          replacements.push({ range, value: cssText });
          styleElement.setAttribute("style", cssText);
        }
      }

      let normalizedHtml = html;
      for (let index = replacements.length - 1; index >= 0; index -= 1) {
        const replacement = replacements[index];
        if (!replacement) return null;
        const encoded = cssNormalizer.escapeAttributeValue(replacement.value, replacement.range.quote);
        const value = replacement.range.quote === null ? `"${encoded}"` : encoded;
        normalizedHtml =
          normalizedHtml.slice(0, replacement.range.start) +
          value +
          normalizedHtml.slice(replacement.range.end);
      }

      return {
        html: normalizedHtml,
        children: Array.from(parsedRoot.children).map((child) => ({
          tag: child.tagName.toLowerCase(),
          html: child.outerHTML,
        })),
      };
    },
    { html: snapshot.final.html, ranges: styleRanges },
  );
  if (!prepared) return snapshot;

  const originalChildren = snapshot.final.children;
  let children = originalChildren;
  // Re-hash only matching child lists; final.html remains the exact non-style guard.
  if (
    originalChildren &&
    originalChildren.length === prepared.children.length &&
    originalChildren.every((child, index) => child.index === index && child.tag === prepared.children[index]?.tag)
  ) {
    children = originalChildren.map((child, index) => {
      const preparedChild = prepared.children[index];
      return preparedChild ? { ...child, hash: hashHtml(preparedChild.html) } : child;
    });
  }
  return {
    ...snapshot,
    final: {
      ...snapshot.final,
      html: prepared.html,
      children,
    },
  };
}

async function compareSnapshotsWithCssom(
  page: Page,
  expected: HtmlSnapshot,
  received: HtmlSnapshot,
): Promise<{ ok: boolean; message?: string }> {
  const preparedExpected = await prepareSnapshotForComparison(page, expected);
  const preparedReceived = await prepareSnapshotForComparison(page, received);
  return compareFinalSnapshots(preparedExpected, preparedReceived);
}

async function readRootText(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const root = document.getElementById("regression-root");
    return root?.textContent ?? "";
  });
}

async function readStructure(page: Page): Promise<{ topLevelTags: string[]; counts: Record<string, number> }> {
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

async function readRootChildren(page: Page): Promise<Array<{ tag: string; html: string; text: string }>> {
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

async function readInspection(page: Page): Promise<RenderInspection> {
  return await page.evaluate(() => {
    const root = document.getElementById("regression-root");
    if (!root) {
      return { tables: [], mdxBlocks: [], codeBlocks: [] };
    }

    const tables = Array.from(root.querySelectorAll("table")).map((table) => {
      const headerRow = table.querySelector("thead tr");
      const headerColumns = headerRow ? headerRow.querySelectorAll("th,td").length : 0;
      const bodyRows = Array.from(table.querySelectorAll("tbody tr"));
      const rowCellCounts = bodyRows.map((row) => row.querySelectorAll("td,th").length);
      let emptyBodyCellCount = 0;
      for (const row of bodyRows) {
        for (const cell of Array.from(row.querySelectorAll("td,th"))) {
          if ((cell.textContent ?? "").trim().length === 0) {
            emptyBodyCellCount += 1;
          }
        }
      }
      return { headerColumns, rowCellCounts, emptyBodyCellCount };
    });

    const mdxBlocks = Array.from(root.querySelectorAll(".markdown-mdx")).map((node) => ({
      status: node instanceof HTMLElement ? node.dataset.mdxStatus ?? null : null,
      textSample: (node.textContent ?? "").slice(0, 160),
    }));

    const codeBlocks = Array.from(root.querySelectorAll("pre code")).map((node) => {
      const text = (node.textContent ?? "").replace(/\r\n?/g, "\n");
      return {
        text,
        lineCount: text.length === 0 ? 0 : text.split("\n").length,
      };
    });

    return { tables, mdxBlocks, codeBlocks };
  });
}

function normalizeCodeText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function getSchedulerPreset(mode: string | null): Record<string, unknown> | null {
  if (!mode) return null;
  const presets: Record<string, Record<string, unknown>> = {
    smooth: {
      scheduling: {
        batch: "rAF",
        frameBudgetMs: 6,
        maxBatchesPerFlush: 4,
        lowPriorityFrameBudgetMs: 3,
        maxLowPriorityBatchesPerFlush: 1,
        urgentQueueThreshold: 2,
      },
    },
    timeout: {
      scheduling: {
        batch: "timeout",
        frameBudgetMs: 8,
        maxBatchesPerFlush: 8,
        lowPriorityFrameBudgetMs: 4,
        maxLowPriorityBatchesPerFlush: 2,
        urgentQueueThreshold: 3,
      },
    },
    microtask: {
      scheduling: {
        batch: "microtask",
        frameBudgetMs: 10,
        maxBatchesPerFlush: 12,
        lowPriorityFrameBudgetMs: 6,
        maxLowPriorityBatchesPerFlush: 2,
        urgentQueueThreshold: 4,
      },
    },
  };
  return presets[mode] ?? null;
}

function buildTraceReplayCommand(fixtureFile: string, mode: "char" | "chunk" = "char"): string {
  return `npx tsx scripts/analyze-test-snippets.ts --trace-lookahead --trace-snippet ${fixtureFile} --trace-mode ${mode}`;
}

function validateTableInspection(
  fixture: ReturnType<typeof getFixtures>[number],
  inspection: RenderInspection,
  label: string,
  failures: string[],
): void {
  if (!fixture.forbidIncompleteTableRows) return;
  const expectedColumns = fixture.expectedTableColumnCount ?? null;
  inspection.tables.forEach((table, tableIndex) => {
    const targetColumns = expectedColumns ?? table.headerColumns;
    if (targetColumns <= 0) {
      failures.push(`${label}: table ${tableIndex} has no header columns.`);
      return;
    }
    if (table.headerColumns > 0 && table.headerColumns !== targetColumns) {
      failures.push(`${label}: table ${tableIndex} header column mismatch (${table.headerColumns} vs ${targetColumns}).`);
    }
    table.rowCellCounts.forEach((cellCount, rowIndex) => {
      if (cellCount !== targetColumns) {
        failures.push(`${label}: table ${tableIndex} row ${rowIndex} cell count mismatch (${cellCount} vs ${targetColumns}).`);
      }
    });
  });
}

function validateCodePrefixInvariant(
  fixture: ReturnType<typeof getFixtures>[number],
  checkpoints: SnapshotCheckpoint[],
  finalInspection: RenderInspection,
  failures: string[],
): void {
  if (!fixture.enforceCodeTextPrefix) return;
  const finalCodeBlocks = finalInspection.codeBlocks.map((block) => normalizeCodeText(block.text));
  if (typeof fixture.expectedCodeBlockCount === "number" && finalCodeBlocks.length !== fixture.expectedCodeBlockCount) {
    failures.push(`final code block count mismatch: expected ${fixture.expectedCodeBlockCount}, got ${finalCodeBlocks.length}.`);
  }

  const previousLineCounts = new Map<number, number>();
  for (const checkpoint of checkpoints) {
    const codeBlocks = checkpoint.inspection?.codeBlocks ?? [];
    if (codeBlocks.length > finalCodeBlocks.length) {
      failures.push(`${checkpoint.id}: code block count exceeded final count (${codeBlocks.length} > ${finalCodeBlocks.length}).`);
      continue;
    }
    codeBlocks.forEach((block, index) => {
      const currentText = normalizeCodeText(block.text);
      const finalText = finalCodeBlocks[index] ?? "";
      if (finalText && !finalText.startsWith(currentText)) {
        failures.push(`${checkpoint.id}: code block ${index} is not a prefix of final rendered text.`);
      }
      const previousLineCount = previousLineCounts.get(index) ?? 0;
      if (block.lineCount < previousLineCount) {
        failures.push(`${checkpoint.id}: code block ${index} line count regressed (${previousLineCount} -> ${block.lineCount}).`);
      }
      previousLineCounts.set(index, block.lineCount);
    });
  }
}

async function validateDisplayFormula(
  page: Page,
  expectedTex: string,
  label: string,
  failures: string[],
): Promise<void> {
  const rendered = await page.evaluate((tex) => {
    const root = document.getElementById("regression-root");
    if (!root || root.querySelector(".katex-error")) return false;
    return Array.from(root.querySelectorAll(".katex-display .katex")).some((formula) => {
      const annotation = formula.querySelector('math[display="block"] annotation[encoding="application/x-tex"]');
      const visual = formula.querySelector(".katex-html");
      return annotation?.textContent === tex && Boolean(visual?.textContent?.trim());
    });
  }, expectedTex);
  if (!rendered) {
    failures.push(`${label}: expected renderable display formula ${JSON.stringify(expectedTex)} without KaTeX errors.`);
  }
}

async function run(): Promise<void> {
  const fixtureFilter = getArg("--filter");
  const scenarioFilter = getArg("--scenario");
  const seed = getArg("--seed");
  const seedCountRaw = getArg("--seed-count");
  const schedulerMode = getArg("--scheduler");
  const seedCount = seedCountRaw ? Math.max(1, Number.parseInt(seedCountRaw, 10) || 1) : 1;
  const requestedSeeds =
    seedCount > 1
      ? Array.from({ length: seedCount }, (_, index) => `${seed ?? "seed"}-${index + 1}`)
      : [seed ?? null];
  const replayMode = requestedSeeds.some((value) => value !== null) || Boolean(schedulerMode);
  const seededReplay = requestedSeeds.some((value) => value !== null);

  const fixtures = getFixtures().filter((fixture) => (fixtureFilter ? fixture.id.includes(fixtureFilter) : true));
  const allScenarios = await loadScenarioFiles();
  const scenarios = allScenarios.filter((scenario) => (scenarioFilter ? scenario.id.includes(scenarioFilter) : true));

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
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext();
  const suppressedConsole = {
    nameNotResolved: 0,
    nameNotResolvedByFixture: {} as Record<string, number>,
  };
  const ignored404Patterns = ["/favicon.ico", "/robots.txt", "/apple-touch-icon", "/site.webmanifest"];
  const unexpected404Urls = new Set<string>();
  let suppressNameNotResolved = false;
  let currentFixtureId = "unknown";
  const attachPageObservers = (
    page: Page,
    capturedLogs: Array<{ type: string; message: string; timestamp: string }>,
  ) => {
    const pushLog = (type: string, message: string) => {
      capturedLogs.push({ type, message, timestamp: new Date().toISOString() });
      if (capturedLogs.length > 200) capturedLogs.shift();
    };

    page.on("pageerror", (error) => {
      const msg = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
      pushLog("pageerror", msg);
      console.error(`\n[regression pageerror] ${msg}`);
    });
    page.on("requestfailed", (request) => {
      const failure = request.failure();
      const msg = `${request.method()} ${request.url()} - ${failure?.errorText ?? "request failed"}`;
      pushLog("requestfailed", msg);
      console.error(`\n[regression requestfailed] ${msg}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        const url = response.url();
        if (response.status() === 404 && ignored404Patterns.some((pattern) => url.includes(pattern))) {
          return;
        }
        if (unexpected404Urls.has(url)) {
          return;
        }
        unexpected404Urls.add(url);
        pushLog("response", `${response.status()} ${url}`);
        console.error(`\n[regression http${response.status()}] ${url}`);
      }
    });
    page.on("console", (message) => {
      const type = message.type();
      const text = message.text();
      if (type === "error") {
        if (text.includes("Failed to load resource: the server responded with a status of 404")) {
          return;
        }
        if (text.includes("net::ERR_NAME_NOT_RESOLVED") && suppressNameNotResolved) {
          suppressedConsole.nameNotResolved += 1;
          suppressedConsole.nameNotResolvedByFixture[currentFixtureId] =
            (suppressedConsole.nameNotResolvedByFixture[currentFixtureId] ?? 0) + 1;
          return;
        }
        pushLog("console.error", text);
        console.error(`\n[regression console.${type}] ${text}`);
      } else if (type === "warning") {
        pushLog("console.warn", text);
      }
    });
    page.on("worker", (worker) => {
      pushLog("worker.created", worker.url());
      worker.on("close", () => {
        pushLog("worker.closed", worker.url());
      });
    });
  };

  let failures = 0;
  const executedByFixture = new Map<string, number>();
  const executedByScenario = new Map<string, number>();

  for (const fixture of fixtures) {
    currentFixtureId = fixture.id;
    suppressNameNotResolved = (fixture.tags ?? []).includes("mdx");
    const rawContent = await readFixtureFile(fixture.file);

    for (const scenario of scenarios) {
      // Seeded replay strips markers and varies chunks. Only its marker eligibility
      // differs from ordinary scenarios; include/exclude tag restrictions still apply.
      const eligibilityScenario = seededReplay && fixture.tags?.includes("split-markers")
        ? { ...scenario, useSplitMarkers: true }
        : scenario;
      if (!shouldRunScenario(fixture, eligibilityScenario)) continue;

      const split = splitMarkers(rawContent);
      const text = split ? split.text : rawContent;
      // Keep the selected ordinary oracle when eligible. Marker-only fixtures
      // use their eligible S5 final without expanding the baseline matrix.
      const baselineScenario = seededReplay && split && !shouldRunScenario(fixture, scenario)
        ? allScenarios.find((candidate) => isSplitScenario(candidate) && shouldRunScenario(fixture, candidate))
        : scenario;
      if (!baselineScenario) {
        throw new Error(`No ordinary split-marker baseline scenario for ${fixture.id}/${scenario.id}.`);
      }
      const snapshotPath = path.join(SNAPSHOT_ROOT, fixture.id, `${baselineScenario.id}.snap.json`);
      const expected = await loadSnapshot(snapshotPath);
      let scenarioFailed = false;
      let baselineReplaySnapshot: HtmlSnapshot | null = null;

      for (const activeSeed of requestedSeeds) {
        executedByFixture.set(fixture.id, (executedByFixture.get(fixture.id) ?? 0) + 1);
        executedByScenario.set(scenario.id, (executedByScenario.get(scenario.id) ?? 0) + 1);
        const page = await context.newPage();
        const capturedLogs: Array<{ type: string; message: string; timestamp: string }> = [];
        attachPageObservers(page, capturedLogs);
        const scenarioDeadline = Date.now() + SCENARIO_TIMEOUT_MS;
        const remainingTimeout = () => {
          const rem = scenarioDeadline - Date.now();
          if (rem <= 0) {
            throw new Error(`Scenario exceeded configured deadline of ${SCENARIO_TIMEOUT_MS}ms`);
          }
          return rem;
        };

        const usesFixedSplit = activeSeed === null && isSplitScenario(scenario) && Boolean(split);
        const chunks = activeSeed !== null
          ? buildSeededChunks(text, scenario, `${fixture.id}:${scenario.id}:${activeSeed}`)
          : isSplitScenario(scenario) && split
            ? split.chunks
            : buildChunks(text, scenario);
        const awaitScenario = async <T>(operation: () => Promise<T>): Promise<T> => {
          const timeoutMs = remainingTimeout();
          let timer: NodeJS.Timeout | undefined;
          const deadlineExpired = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`Scenario exceeded configured deadline of ${SCENARIO_TIMEOUT_MS}ms`));
            }, timeoutMs);
          });
          try {
            const result = await Promise.race([Promise.resolve().then(operation), deadlineExpired]);
            remainingTimeout();
            return result;
          } finally {
            clearTimeout(timer);
          }
        };
        const enforcePrefixInvariant = !["article", "footnotes", "html", "lists", "math", "mdx", "table", "code"].some((tag) =>
          (fixture.tags ?? []).includes(tag),
        );
        const waitForMdxCompiled = fixture.waitForMdxCompiled ?? (fixture.tags ?? []).includes("mdx");
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
        let partialSnapshot: Partial<HtmlSnapshot> | null = null;
        let lastKnownRuntimeState: unknown = null;
        let lastKnownHtml = "";

        try {
          await awaitScenario(() =>
            page.goto(`${BASE_URL}/regression/html/`, { waitUntil: "load", timeout: remainingTimeout() }),
          );
          await awaitScenario(() =>
            page.waitForFunction(
              () => Boolean(window.__streammdxRegression),
              undefined,
              { timeout: remainingTimeout() },
            ),
          );
          await awaitScenario(() =>
            page.evaluate(
              async ({ fixtureId, scenarioId, nextSeed, nextSchedulerMode, preset }) => {
                window.__streammdxRegression?.setMeta({
                  fixtureId,
                  scenarioId,
                  seed: nextSeed ?? undefined,
                  schedulerMode: nextSchedulerMode ?? undefined,
                });
                if (preset && window.__streammdxRegression?.setConfig) {
                  await window.__streammdxRegression.setConfig(preset);
                }
              },
              {
                fixtureId: fixture.id,
                scenarioId: scenario.id,
                nextSeed: activeSeed,
                nextSchedulerMode: schedulerMode,
                preset: getSchedulerPreset(schedulerMode),
              },
            ),
          );
          await awaitScenario(() =>
            page.evaluate((timeout) => window.__streammdxRegression?.waitForReady(timeout), remainingTimeout()),
          );
          if (fixture.id === "complete-append-frontier" && usesFixedSplit) {
            await awaitScenario(() =>
              page.evaluate(async (timeout) => {
                const api = window.__streammdxRegression;
                if (!api) throw new Error("Regression API unavailable before empty restart.");
                const configuring = api.setConfig({ showCodeMeta: false });
                api.restart();
                await configuring;
                await api.waitForReady(timeout);
              }, remainingTimeout()),
            );
          }
          let appended = 0;
          let firstChunkCaptured = false;
          let tableFirstSeenAt: number | null = null;
          let lastCheckpointText = "";
          let lastCheckpointChildCount = 0;
          const streamInvariantFailures: string[] = [];

          const captureCheckpoint = async (
            id: string,
            summary: { rootChildCount: number; selectors: Record<string, boolean>; counts?: Record<string, number> },
          ) => {
            const html = await page.evaluate(() => window.__streammdxRegression?.getHtml());
            const runtimeState = (await page.evaluate(
              () => window.__streammdxRegression?.getRuntimeState?.(),
            )) as SnapshotCheckpoint["runtimeState"];
            const structure = await readStructure(page);
            const inspection = await readInspection(page);
            const textContent = await readRootText(page);
            if (
              enforcePrefixInvariant &&
              !summary.selectors.hasMdxPending &&
              lastCheckpointText &&
              !textContent.startsWith(lastCheckpointText)
            ) {
              streamInvariantFailures.push(`text prefix invariant failed at ${id} (${fixture.id}/${scenario.id}).`);
            }
            if (summary.rootChildCount < lastCheckpointChildCount) {
              streamInvariantFailures.push(`${id}: root child count decreased (${lastCheckpointChildCount} -> ${summary.rootChildCount}).`);
            }
            if (fixture.forbidIncompleteTableRowsDuringStreaming) {
              validateTableInspection(fixture, inspection, id, streamInvariantFailures);
            }
            lastCheckpointText = textContent;
            lastCheckpointChildCount = summary.rootChildCount;
            checkpoints.push({
              id,
              appendedChars: appended,
              rootChildCount: summary.rootChildCount,
              runtimeState,
              selectors: summary.selectors,
              counts: summary.counts,
              html: html ?? "",
            textSample: textContent.slice(0, 200),
            structure,
            inspection,
          });
          lastKnownHtml = html ?? "";
          lastKnownRuntimeState = runtimeState;
          partialSnapshot = {
            fixtureId: fixture.id,
            fixtureTitle: fixture.title,
            scenarioId: scenario.id,
            scenario,
            totalLength: text.length,
            checkpoints: [...checkpoints],
          };
        };

          for (const chunk of chunks) {
            const nextAppended = appended + chunk.length;
            if (fixture.id === "complete-append-frontier" && usesFixedSplit) {
              const expectedFrontier = text.slice(0, nextAppended);
              const frontier = await awaitScenario(() =>
                page.evaluate(async ({ value, expected }) => {
                  const api = window.__streammdxRegression;
                  if (!api) throw new Error("Regression API unavailable while checking append frontier.");
                  await api.appendAndFlush(value);
                  const root = document.getElementById("regression-root");
                  const paragraphs = root?.querySelectorAll("p.markdown-paragraph");
                  const paragraphCount = paragraphs?.length ?? 0;
                  const paragraphText = paragraphCount === 1 ? paragraphs?.[0]?.textContent ?? "" : null;
                  return {
                    matches: paragraphCount === 1 && paragraphText === expected,
                    paragraphCount,
                    textLength: paragraphText?.length ?? -1,
                  };
                }, { value: chunk, expected: expectedFrontier }),
              );
              if (!frontier.matches) {
                streamInvariantFailures.push(
                  `append frontier mismatch at ${nextAppended} source units: expected one paragraph with ` +
                    `${expectedFrontier.length} UTF-16 units, got ${frontier.paragraphCount} paragraph(s) and ` +
                    `${frontier.textLength} UTF-16 units.`,
                );
              }
            } else {
              await awaitScenario(() =>
                page.evaluate((value) => window.__streammdxRegression?.appendAndFlush(value), chunk),
              );
            }
            appended = nextAppended;

            const summary = await awaitScenario(() => readSummary(page, remainingTimeout));
            if (tableFirstSeenAt === null && summary.selectors.hasTable) {
              tableFirstSeenAt = appended;
            }
            if (summary.counts?.table && tableFirstSeenAt === null) {
              tableFirstSeenAt = appended;
            }
            if (fixture.id === "math-display-checkpoint-supported" && usesFixedSplit && appended === split?.chunks[0].length) {
              await awaitScenario(() =>
                validateDisplayFormula(page, "a_n = \\frac{1}{n}", "explicit split boundary", streamInvariantFailures),
              );
            }

            if (!firstChunkCaptured) {
              await awaitScenario(() => captureCheckpoint("after-first-chunk", summary));
              firstChunkCaptured = true;
            }

            while (checkpointTargets.length > 0 && appended >= checkpointTargets[0]) {
              const target = checkpointTargets.shift();
              if (target !== undefined && !checkpointSet.has(target)) {
                checkpointSet.add(target);
                await awaitScenario(() => captureCheckpoint(`progress-${target}`, summary));
              }
            }

            for (const [key, value] of Object.entries(summary.selectors)) {
              if (value && !seenEvents[key]) {
                seenEvents[key] = true;
                await awaitScenario(() => captureCheckpoint(`event-${key}`, summary));
              }
            }

            if ((fixture.forbidSelectorsDuringStreaming?.length ?? 0) > 0) {
              const forbiddenDuringStreaming = (await awaitScenario(() =>
                page.evaluate((selectors) => {
                  const root = document.getElementById("regression-root");
                  if (!root) return selectors;
                  return selectors.filter((selector) => root.querySelector(selector));
                }, fixture.forbidSelectorsDuringStreaming ?? []),
              )) as string[];
              if (forbiddenDuringStreaming.length > 0) {
                streamInvariantFailures.push(
                  `forbidden selectors visible during streaming: ${forbiddenDuringStreaming.join(", ")}.`,
                );
              }
            }
            if ((fixture.forbidHtmlFragmentsDuringStreaming?.length ?? 0) > 0) {
              const forbiddenHtmlFragments = (fixture.forbidHtmlFragmentsDuringStreaming ?? []).filter((fragment) =>
                checkpoints[checkpoints.length - 1]?.html.includes(fragment),
              );
              if (forbiddenHtmlFragments.length > 0) {
                streamInvariantFailures.push(
                  `forbidden html fragments visible during streaming: ${forbiddenHtmlFragments.join(", ")}.`,
                );
              }
            }
          }

          await awaitScenario(() => page.evaluate(() => window.__streammdxRegression?.finalizeAndFlush()));

          if (waitForMdxCompiled) {
            try {
              await awaitScenario(() =>
                page.waitForFunction(
                  () => {
                    const summary = window.__streammdxRegression?.getSummary();
                    if (!summary) return false;
                    return summary.selectors.hasMdxCompiled && !summary.selectors.hasMdxPending;
                  },
                  undefined,
                  { timeout: remainingTimeout() },
                ),
              );
            } catch (error) {
              failures += 1;
              scenarioFailed = true;
              console.error(`\nMDX compile timeout for ${fixture.id}/${scenario.id} seed=${activeSeed ?? "baseline"}`);
              console.error(error);
            }
          }

          const invariantViolations = (await awaitScenario(() =>
            page.evaluate(() => window.__streammdxRegression?.getInvariantViolations?.() ?? []),
          )) as { message: string }[];
        if (streamInvariantFailures.length > 0) {
          failures += 1;
          scenarioFailed = true;
          console.error(`\nStreaming invariant violations for ${fixture.id}/${scenario.id} seed=${activeSeed ?? "baseline"}:`);
          for (const message of streamInvariantFailures) {
            console.error(`- ${message}`);
          }
        }
        const fatalInvariantViolations = invariantViolations.filter((violation) => !violation.message.startsWith("stale epoch rejected:"));
        if (fatalInvariantViolations.length > 0) {
          failures += 1;
          scenarioFailed = true;
          console.error(`\nInvariant violations for ${fixture.id}/${scenario.id} seed=${activeSeed ?? "baseline"}:`);
          for (const violation of fatalInvariantViolations) {
            console.error(`- ${violation.message}`);
          }
        }

        const finalSummary = (await awaitScenario(() =>
          page.evaluate(() => window.__streammdxRegression?.getSummary()),
        )) as {
          rootChildCount: number;
          selectors: Record<string, boolean>;
          counts?: Record<string, number>;
        };
        for (const [key, value] of Object.entries(finalSummary.selectors)) {
          if (value && !seenEvents[key]) {
            seenEvents[key] = true;
            await awaitScenario(() => captureCheckpoint(`event-${key}`, finalSummary));
          }
        }
        const finalHtml = await awaitScenario(() => page.evaluate(() => window.__streammdxRegression?.getHtml()));
        const finalRuntimeState = (await awaitScenario(() =>
          page.evaluate(() => window.__streammdxRegression?.getRuntimeState?.()),
        )) as SnapshotCheckpoint["runtimeState"];
        const finalStructure = await awaitScenario(() => readStructure(page));
        const finalInspection = await awaitScenario(() => readInspection(page));
        const rootChildren = await awaitScenario(() => readRootChildren(page));
         const childHashes = rootChildren.map((child, index) => ({
           index,
           tag: child.tag,
           hash: hashHtml(child.html),
           textSample: child.text,
         }));
         const snapshot: HtmlSnapshot = {
           fixtureId: fixture.id,
           fixtureTitle: fixture.title,
           scenarioId: scenario.id,
           scenario,
           runMeta: {
             seed: activeSeed,
             schedulerMode,
             usedSplitMarkers: usesFixedSplit,
             fixtureTags: [...(fixture.tags ?? [])],
           },
           totalLength: text.length,
           checkpoints,
           final: {
             id: "after-finalize",
             appendedChars: appended,
             rootChildCount: finalSummary.rootChildCount,
             selectors: finalSummary.selectors,
             html: finalHtml ?? "",
             runtimeState: finalRuntimeState,
             structure: finalStructure,
             children: childHashes,
             inspection: finalInspection,
           },
         };
         const htmlInvariantFailures: string[] = [];
        if (fixture.id === "complete-append-frontier" && usesFixedSplit) {
          const finalFrontier = await awaitScenario(() =>
            page.evaluate((expected) => {
              const root = document.getElementById("regression-root");
              const paragraphs = root?.querySelectorAll("p.markdown-paragraph");
              const paragraphCount = paragraphs?.length ?? 0;
              const paragraphText = paragraphCount === 1 ? paragraphs?.[0]?.textContent ?? "" : null;
              return {
                matches: paragraphCount === 1 && paragraphText === expected,
                paragraphCount,
                textLength: paragraphText?.length ?? -1,
              };
            }, text),
          );
          if (!finalFrontier.matches) {
            htmlInvariantFailures.push(
              `after-finalize: expected one paragraph with ${text.length} UTF-16 units, got ` +
                `${finalFrontier.paragraphCount} paragraph(s) and ${finalFrontier.textLength} UTF-16 units.`,
            );
          }
        }
         const finalHtmlValue = finalHtml ?? "";
         const rawBlockMathNeedle = '<p class="markdown-paragraph">$$';
         const rawInlineCodeNeedle =
          "`this is a really really really really really really really really really really really really really really really really really really really really really long inline code span`";
        const isSanitizationFixture = (fixture.tags ?? []).includes("sanitization");
        const emptyNestedListCount = fixture.forbidEmptyNestedLists
          ? await awaitScenario(() =>
              page.evaluate(() => {
                const root = document.getElementById("regression-root");
                if (!root) return 0;
                const nestedLists = root.querySelectorAll(
                  ".markdown-list-item-children > ol.markdown-list, .markdown-list-item-children > ul.markdown-list",
                );
                let emptyCount = 0;
                for (const list of nestedLists) {
                  const hasItems = Array.from(list.children).some(
                    (child) => child instanceof HTMLElement && child.classList.contains("markdown-list-item"),
                  );
                  if (!hasItems) emptyCount += 1;
                }
                return emptyCount;
              }),
            )
          : 0;
        if (!fixture.allowRawBlockMath && finalHtmlValue.includes(rawBlockMathNeedle)) {
          htmlInvariantFailures.push("raw block math detected in paragraph (expected KaTeX output).");
        }
        if (finalHtmlValue.includes(rawInlineCodeNeedle)) {
          htmlInvariantFailures.push("raw backtick inline code detected (expected <code> output).");
        }
        if (emptyNestedListCount > 0) {
          htmlInvariantFailures.push(`empty nested list container detected (${emptyNestedListCount}).`);
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
        if (tableTargetChars !== null && (tableFirstSeenAt === null || tableFirstSeenAt > tableTargetChars)) {
          htmlInvariantFailures.push(
            `table was not visible by ${Math.round(tableTargetPct! * 100)}% (first seen at ${tableFirstSeenAt ?? "never"} / ${tableTargetChars} chars).`,
          );
        }
        if (typeof fixture.expectedListItemCount === "number") {
          const listItemCount = await awaitScenario(() =>
            page.evaluate(() => {
              const root = document.getElementById("regression-root");
              return root?.querySelectorAll("li").length ?? 0;
            }),
          );
          if (listItemCount !== fixture.expectedListItemCount) {
            htmlInvariantFailures.push(`list item count mismatch: expected ${fixture.expectedListItemCount}, got ${listItemCount}.`);
          }
        }
        if (fixture.requiredTextFragments?.length) {
          // Fragments describe rendered *text*; syntax highlighting splits source across <span>
          // tokens, so matching the serialized HTML string is incidental to the highlighter markup.
          // Validate against the DOM text of the regression root instead - verbatim, so meaningful
          // characters, newlines and protocols are not normalized away.
          const renderedText = await awaitScenario(() =>
            page.evaluate(() => {
              const root = document.getElementById("regression-root");
              return root ? (root.textContent ?? "") : null;
            }),
          );
          const missingFragments = findMissingRequiredTextFragments(fixture.requiredTextFragments, renderedText);
          if (missingFragments.length > 0) {
            htmlInvariantFailures.push(`missing required text fragments: ${missingFragments.join(", ")}.`);
          }
        }
        if (fixture.forbidTextFragments?.length) {
          const presentForbiddenFragments = fixture.forbidTextFragments.filter((fragment) => finalHtmlValue.includes(fragment));
          if (presentForbiddenFragments.length > 0) {
            htmlInvariantFailures.push(`forbidden text fragments present: ${presentForbiddenFragments.join(", ")}.`);
          }
        }
        if (fixture.forbidHtmlFragments?.length) {
          const presentForbiddenHtmlFragments = fixture.forbidHtmlFragments.filter((fragment) => finalHtmlValue.includes(fragment));
          if (presentForbiddenHtmlFragments.length > 0) {
            htmlInvariantFailures.push(`forbidden html fragments present: ${presentForbiddenHtmlFragments.join(", ")}.`);
          }
        }
        if (typeof fixture.expectedMdxBlockCount === "number" && finalInspection.mdxBlocks.length !== fixture.expectedMdxBlockCount) {
          htmlInvariantFailures.push(
            `final mdx block count mismatch: expected ${fixture.expectedMdxBlockCount}, got ${finalInspection.mdxBlocks.length}.`,
          );
        }
        validateTableInspection(fixture, finalInspection, "after-finalize", htmlInvariantFailures);
        validateCodePrefixInvariant(fixture, checkpoints, finalInspection, htmlInvariantFailures);
        if (fixture.id === "math-display-checkpoint-supported") {
          await awaitScenario(() =>
            validateDisplayFormula(page, "a_n = \\frac{1}{n}\n\\sqrt{x}", "after-finalize", htmlInvariantFailures),
          );
        }


        if (htmlInvariantFailures.length > 0) {
          failures += 1;
          scenarioFailed = true;
          const msg = `HTML invariant violations for ${fixture.id}/${scenario.id} seed=${activeSeed ?? "baseline"}:\n` +
            htmlInvariantFailures.map((m) => `- ${m}`).join("\n");
          console.error(`\n${msg}`);
          const artifactDir = await writeFailureArtifacts({
            fixtureId: fixture.id,
            scenarioId: scenario.id,
            label: `html-invariants-${activeSeed ?? "baseline"}`,
            message: msg,
            received: snapshot,
            runtimeState: finalRuntimeState,
            html: finalHtmlValue,
            capturedLogs,
          });
          console.error(`artifacts: ${artifactDir}`);
          console.error(`trace replay: ${buildTraceReplayCommand(fixture.file)}`);
        }
        const requiredSelectors = fixture.requiredSelectors ?? [];
        if (requiredSelectors.length > 0) {
          const missing = (await awaitScenario(() =>
            page.evaluate((selectors) => {
              const root = document.getElementById("regression-root");
              if (!root) return selectors;
              return selectors.filter((selector) => !root.querySelector(selector));
            }, requiredSelectors),
          )) as string[];
          if (missing.length > 0) {
            failures += 1;
            scenarioFailed = true;
            console.error(`\nMissing required selectors for ${fixture.id}/${scenario.id} seed=${activeSeed ?? "baseline"}: ${missing.join(", ")}`);
          }
        }
        const forbidSelectors = fixture.forbidSelectors ?? [];
        if (forbidSelectors.length > 0) {
          const presentForbidden = (await awaitScenario(() =>
            page.evaluate((selectors) => {
              const root = document.getElementById("regression-root");
              if (!root) return [];
              return selectors.filter((selector) => root.querySelector(selector));
            }, forbidSelectors),
          )) as string[];
          if (presentForbidden.length > 0) {
            failures += 1;
            scenarioFailed = true;
            console.error(
              `\nForbidden selectors present for ${fixture.id}/${scenario.id} seed=${activeSeed ?? "baseline"}: ${presentForbidden.join(", ")}`,
            );
         }
        }
 
         if (!replayMode) {
          if (UPDATE) {
            if (scenarioFailed) {
              console.warn(`skipped update for ${fixture.id}/${scenario.id} due to failures`);
            } else {
              await awaitScenario(() => writeSnapshot(snapshotPath, snapshot, remainingTimeout));
              console.log(`updated ${fixture.id}/${scenario.id}`);
            }
            continue;
          }

          if (!expected) {
            console.error(`missing snapshot for ${fixture.id}/${scenario.id}`);
            failures += 1;
            scenarioFailed = true;
            continue;
          }

          const result = await awaitScenario(() => compareSnapshotsWithCssom(page, expected, snapshot));
          if (!result.ok) {
            failures += 1;
            const artifactDir = await writeComparisonArtifacts({
              fixtureId: fixture.id,
              scenarioId: scenario.id,
              label: "baseline-regression",
              expected,
              received: snapshot,
              message: result.message ?? "HTML regression",
              capturedLogs,
            });
            console.error(`\nHTML regression: ${fixture.id} / ${scenario.id}\n${result.message}\n`);
            console.error(`artifacts: ${artifactDir}`);
            console.error(`trace replay: ${buildTraceReplayCommand(fixture.file)}`);
          } else {
            console.log(`ok ${fixture.id}/${scenario.id}`);
          }
          continue;
        }

          if (UPDATE) {
          console.warn(`skipping snapshot update in replay mode for ${fixture.id}/${scenario.id}`);
        }
          if (!expected) {
            console.error(`missing snapshot for ${fixture.id}/${baselineScenario.id} (replay ${scenario.id})`);
            failures += 1;
            scenarioFailed = true;
          }
          if (expected) {
          const result = await awaitScenario(() => compareSnapshotsWithCssom(page, expected, snapshot));
          if (!result.ok) {
            failures += 1;
            scenarioFailed = true;
            const artifactDir = await writeComparisonArtifacts({
              fixtureId: fixture.id,
              scenarioId: scenario.id,
              label: `baseline-parity-${activeSeed ?? "baseline"}`,
              expected,
              received: snapshot,
              message: result.message ?? "Final HTML parity mismatch vs baseline snapshot",
              capturedLogs,
            });
            console.error(
              `\nFinal HTML parity mismatch vs baseline snapshot for ${fixture.id}/${scenario.id} seed=${activeSeed ?? "baseline"}\n${result.message ?? ""}\n`,
            );
            console.error(`artifacts: ${artifactDir}`);
            console.error(`trace replay: ${buildTraceReplayCommand(fixture.file)}`);
          }
        }
          if (!baselineReplaySnapshot) {
          baselineReplaySnapshot = snapshot;
        } else {
          const replayResult = await awaitScenario(() =>
            compareSnapshotsWithCssom(page, baselineReplaySnapshot, snapshot),
          );
          if (!replayResult.ok) {
            failures += 1;
            scenarioFailed = true;
            const artifactDir = await writeComparisonArtifacts({
              fixtureId: fixture.id,
              scenarioId: scenario.id,
              label: `replay-divergence-${baselineReplaySnapshot.runMeta?.seed ?? "baseline"}-vs-${activeSeed ?? "baseline"}`,
              expected: baselineReplaySnapshot,
              received: snapshot,
              message: replayResult.message ?? "Replay divergence",
              capturedLogs,
            });
            console.error(
              `\nReplay divergence for ${fixture.id}/${scenario.id}: baseline seed=${baselineReplaySnapshot.runMeta?.seed ?? "baseline"} vs ${activeSeed ?? "baseline"}\n${replayResult.message ?? ""}\n`,
            );
            console.error(`artifacts: ${artifactDir}`);
             console.error(`trace replay: ${buildTraceReplayCommand(fixture.file)}`);
           }
         }
         if (!scenarioFailed) {
           console.log(`ok ${fixture.id}/${scenario.id} seed=${activeSeed ?? "baseline"}`);
         }
      } catch (error) {
        failures += 1;
        scenarioFailed = true;
        console.error(`\n[regression scenario error] ${fixture.id}/${scenario.id} seed=${activeSeed ?? "baseline"}:`, error);
        try {
          lastKnownHtml =
            (await awaitScenario(() => page.evaluate(() => window.__streammdxRegression?.getHtml()))) ?? lastKnownHtml;
          lastKnownRuntimeState =
            (await awaitScenario(() => page.evaluate(() => window.__streammdxRegression?.getRuntimeState?.()))) ??
            lastKnownRuntimeState;
        } catch {
          // Deadline expiry or a disconnected page leaves the last captured checkpoint as the diagnostic source.
        }
        const artifactDir = await writeFailureArtifacts({
          fixtureId: fixture.id,
          scenarioId: scenario.id,
          label: `scenario-error-${activeSeed ?? "baseline"}`,
          error,
          received: partialSnapshot,
          runtimeState: lastKnownRuntimeState,
          html: lastKnownHtml,
          capturedLogs,
        });
        console.error(`artifacts: ${artifactDir}`);
        console.error(`trace replay: ${buildTraceReplayCommand(fixture.file)}`);
      } finally {
        await page.close().catch((error) => {
          console.error(`Failed to close regression page for ${fixture.id}/${scenario.id} seed=${activeSeed ?? "baseline"}:`, error);
          process.exitCode = 1;
        });
      }
    }
  }
  }

  if (executedByFixture.size === 0) {
    failures += 1;
    console.error("No fixture/scenario cases executed after eligibility filters.");
  } else {
    if (fixtureFilter) {
      for (const fixture of fixtures) {
        if (executedByFixture.has(fixture.id)) continue;
        failures += 1;
        console.error(`No cases executed for requested fixture ${fixture.id} after eligibility filters.`);
      }
    }
    if (scenarioFilter) {
      for (const scenario of scenarios) {
        if (executedByScenario.has(scenario.id)) continue;
        failures += 1;
        console.error(`No cases executed for requested scenario ${scenario.id} after eligibility filters.`);
      }
    }
  }

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
  } finally {
    // Cleanup failures must fail the command without replacing a replay error.
    await context?.close().catch((error) => {
      console.error("Failed to close regression browser context:", error);
      process.exitCode = 1;
    });
    await browser.close().catch((error) => {
      console.error("Failed to close regression browser:", error);
      process.exitCode = 1;
    });
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
