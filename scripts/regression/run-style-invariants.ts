import assert from "node:assert";

import { chromium, type Page } from "@playwright/test";

import { loadScenarioFiles, readFixtureFile, splitMarkers, buildChunks, shouldRunScenario, isSplitScenario, getFixtures } from "./utils";

const BASE_URL = process.env.STREAM_MDX_REGRESSION_BASE_URL || "http://localhost:3000";

function parsePx(value: string | null | undefined): number {
  if (!value) return 0;
  const match = value.trim().match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function parseCssNumber(value: string | null | undefined): number {
  if (!value) return 0;
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : 0;
}

function parseRgb(value: string | null | undefined): [number, number, number] | null {
  if (!value) return null;
  const hexMatch = value.trim().match(/^#([0-9a-f]{6})$/i);
  if (hexMatch) {
    const hex = hexMatch[1];
    return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
  }
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (match) {
    const parts = match[1]
      .split(",")
      .slice(0, 3)
      .map((part) => Number(part.trim()));
    if (parts.some((part) => Number.isNaN(part))) return null;
    return [parts[0]!, parts[1]!, parts[2]!];
  }
  const srgbMatch = value.match(/color\(srgb\s+([^\s]+)\s+([^\s]+)\s+([^\s)]+)\)/);
  if (srgbMatch) {
    const parts = [srgbMatch[1], srgbMatch[2], srgbMatch[3]].map((part) => Math.round(Number(part) * 255));
    if (parts.some((part) => Number.isNaN(part))) return null;
    return [parts[0]!, parts[1]!, parts[2]!];
  }
  const oklabMatch = value.match(/oklab\(([^)\s]+)\s+([^)\s]+)\s+([^)\s]+)\)/);
  if (!oklabMatch) return null;
  const [L, a, b] = [oklabMatch[1], oklabMatch[2], oklabMatch[3]].map((part) => Number(part));
  if ([L, a, b].some((part) => Number.isNaN(part))) return null;
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const srgb = linear.map((channel) => {
    const clamped = Math.min(1, Math.max(0, channel));
    const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255);
  });
  return [srgb[0]!, srgb[1]!, srgb[2]!];
}

function srgbToLinear(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map(srgbToLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: [number, number, number], background: [number, number, number]): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

async function streamFixture(page: Page, fixtureId: string, scenarioId = "S2_typical"): Promise<void> {
  const fixture = getFixtures().find((entry) => entry.id === fixtureId);
  assert.ok(fixture, `missing fixture: ${fixtureId}`);
  const scenario = (await loadScenarioFiles()).find((entry) => entry.id === scenarioId);
  assert.ok(scenario, `missing scenario: ${scenarioId}`);
  assert.ok(shouldRunScenario(fixture, scenario), `scenario ${scenarioId} should not run for ${fixtureId}`);

  const rawContent = await readFixtureFile(fixture.file);
  const split = splitMarkers(rawContent);
  const text = split ? split.text : rawContent;
  const chunks = isSplitScenario(scenario) && split ? split.chunks : buildChunks(text, scenario);

  await page.goto(`${BASE_URL}/regression/html/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__streammdxRegression));
  await page.evaluate(
    ({ fixtureId: id, scenarioId: scenario }) => window.__streammdxRegression?.setMeta({ fixtureId: id, scenarioId: scenario }),
    { fixtureId, scenarioId },
  );
  await page.evaluate(() => window.__streammdxRegression?.waitForReady());

  for (const chunk of chunks) {
    await page.evaluate((value) => window.__streammdxRegression?.appendAndFlush(value), chunk);
  }

  await page.evaluate(() => window.__streammdxRegression?.finalizeAndFlush());
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.classList.toggle("dark", value === "dark");
  }, theme);
}

async function checkListGeometry(page: Page, theme: "light" | "dark"): Promise<void> {
  await streamFixture(page, "list-long");
  await setTheme(page, theme);

  const listLong = await page.evaluate(() => {
    const rootOrdered = document.querySelector("#regression-root .markdown-list.ordered") as HTMLElement | null;
    const rootOrderedFirst = rootOrdered?.querySelector(":scope > .markdown-list-item") as HTMLElement | null;
    const rootUnordered = document.querySelector("#regression-root .markdown-list.unordered") as HTMLElement | null;
    const rootUnorderedFirst = rootUnordered?.querySelector(":scope > .markdown-list-item") as HTMLElement | null;
    const nestedUnordered = document.querySelector("#regression-root li .markdown-list.unordered") as HTMLElement | null;
    const nestedUnorderedFirst = nestedUnordered?.querySelector(":scope > .markdown-list-item") as HTMLElement | null;

    return {
      ordered:
        rootOrdered && rootOrderedFirst
          ? {
              markerDigitsAttr: rootOrdered.getAttribute("data-marker-digits"),
              markerDigitsVar: getComputedStyle(rootOrdered).getPropertyValue("--list-marker-digits").trim(),
              paddingLeft: getComputedStyle(rootOrdered).paddingLeft,
              markerLeft: getComputedStyle(rootOrderedFirst, "::before").left,
              markerWidth: getComputedStyle(rootOrderedFirst, "::before").width,
              markerPaddingRight: getComputedStyle(rootOrderedFirst, "::before").paddingRight,
              markerContent: getComputedStyle(rootOrderedFirst, "::before").content,
            }
          : null,
      unordered:
        rootUnordered && rootUnorderedFirst
          ? {
              markerDigitsAttr: rootUnordered.getAttribute("data-marker-digits"),
              markerDigitsVar: getComputedStyle(rootUnordered).getPropertyValue("--list-marker-digits").trim(),
              paddingLeft: getComputedStyle(rootUnordered).paddingLeft,
              markerLeft: getComputedStyle(rootUnorderedFirst, "::before").left,
              markerWidth: getComputedStyle(rootUnorderedFirst, "::before").width,
              markerPaddingRight: getComputedStyle(rootUnorderedFirst, "::before").paddingRight,
              markerContent: getComputedStyle(rootUnorderedFirst, "::before").content,
            }
          : null,
      nestedUnordered:
        nestedUnordered && nestedUnorderedFirst
          ? {
              markerDigitsAttr: nestedUnordered.getAttribute("data-marker-digits"),
              markerDigitsVar: getComputedStyle(nestedUnordered).getPropertyValue("--list-marker-digits").trim(),
              paddingLeft: getComputedStyle(nestedUnordered).paddingLeft,
              markerLeft: getComputedStyle(nestedUnorderedFirst, "::before").left,
              markerWidth: getComputedStyle(nestedUnorderedFirst, "::before").width,
              markerPaddingRight: getComputedStyle(nestedUnorderedFirst, "::before").paddingRight,
              markerContent: getComputedStyle(nestedUnorderedFirst, "::before").content,
            }
          : null,
    };
  });

  assert.ok(listLong.ordered, `missing ordered list data for ${theme}`);
  assert.ok(listLong.unordered, `missing unordered list data for ${theme}`);
  assert.strictEqual(listLong.ordered.markerDigitsAttr, "2", `ordered list should advertise 2-digit markers in ${theme}`);
  assert.strictEqual(listLong.ordered.markerDigitsVar, "2", `ordered list CSS variable should be 2 in ${theme}`);

  const orderedPadding = parsePx(listLong.ordered.paddingLeft);
  const orderedLeft = parsePx(listLong.ordered.markerLeft);
  const orderedWidth = parsePx(listLong.ordered.markerWidth);
  assert.ok(orderedPadding > 0, `ordered list padding must be positive in ${theme}`);
  assert.ok(Math.abs(Math.abs(orderedLeft) - orderedWidth) <= 0.75, `ordered marker left/width must align in ${theme}`);
  assert.ok(Math.abs(orderedPadding - orderedWidth) <= 0.75, `ordered list padding should equal marker width in ${theme}`);

  const unorderedPadding = parsePx(listLong.unordered.paddingLeft);
  const unorderedLeft = parsePx(listLong.unordered.markerLeft);
  const unorderedWidth = parsePx(listLong.unordered.markerWidth);
  assert.ok(Math.abs(Math.abs(unorderedLeft) - unorderedWidth) <= 0.75, `unordered marker left/width must align in ${theme}`);
  assert.ok(Math.abs(unorderedPadding - unorderedWidth) <= 0.75, `unordered list padding should equal marker width in ${theme}`);
  assert.ok(orderedWidth > unorderedWidth, `two-digit ordered markers should reserve more width than bullets in ${theme}`);
  assert.ok(listLong.unordered.markerContent.includes("•"), `unordered marker should render a bullet in ${theme}`);

  if (listLong.nestedUnordered) {
    const nestedPadding = parsePx(listLong.nestedUnordered.paddingLeft);
    const nestedLeft = parsePx(listLong.nestedUnordered.markerLeft);
    const nestedWidth = parsePx(listLong.nestedUnordered.markerWidth);
    assert.ok(Math.abs(Math.abs(nestedLeft) - nestedWidth) <= 0.75, `nested unordered marker left/width must align in ${theme}`);
    assert.ok(Math.abs(nestedPadding - nestedWidth) <= 0.75, `nested unordered list padding should equal marker width in ${theme}`);
  }

  await streamFixture(page, "lists-nested");
  await setTheme(page, theme);

  const nested = await page.evaluate(() => {
    const rootOrdered = document.querySelector("#regression-root .markdown-list.ordered") as HTMLElement | null;
    const nestedOrdered = document.querySelector("#regression-root li .markdown-list.ordered") as HTMLElement | null;
    const nestedUnordered = document.querySelector("#regression-root li .markdown-list.unordered") as HTMLElement | null;

    return {
      rootOrdered:
        rootOrdered && rootOrdered.querySelector(":scope > .markdown-list-item")
          ? {
              depth: rootOrdered.getAttribute("data-list-depth"),
              markerDigitsAttr: rootOrdered.getAttribute("data-marker-digits"),
              markerDigitsVar: getComputedStyle(rootOrdered).getPropertyValue("--list-marker-digits").trim(),
              paddingLeft: getComputedStyle(rootOrdered).paddingLeft,
              markerLeft: getComputedStyle(rootOrdered.querySelector(":scope > .markdown-list-item") as HTMLElement, "::before").left,
              markerWidth: getComputedStyle(rootOrdered.querySelector(":scope > .markdown-list-item") as HTMLElement, "::before").width,
            }
          : null,
      nestedOrdered:
        nestedOrdered && nestedOrdered.querySelector(":scope > .markdown-list-item")
          ? {
              depth: nestedOrdered.getAttribute("data-list-depth"),
              markerDigitsAttr: nestedOrdered.getAttribute("data-marker-digits"),
              markerDigitsVar: getComputedStyle(nestedOrdered).getPropertyValue("--list-marker-digits").trim(),
              paddingLeft: getComputedStyle(nestedOrdered).paddingLeft,
              markerLeft: getComputedStyle(nestedOrdered.querySelector(":scope > .markdown-list-item") as HTMLElement, "::before").left,
              markerWidth: getComputedStyle(nestedOrdered.querySelector(":scope > .markdown-list-item") as HTMLElement, "::before").width,
            }
          : null,
      nestedUnordered:
        nestedUnordered && nestedUnordered.querySelector(":scope > .markdown-list-item")
          ? {
              depth: nestedUnordered.getAttribute("data-list-depth"),
              markerDigitsAttr: nestedUnordered.getAttribute("data-marker-digits"),
              markerDigitsVar: getComputedStyle(nestedUnordered).getPropertyValue("--list-marker-digits").trim(),
              paddingLeft: getComputedStyle(nestedUnordered).paddingLeft,
              markerLeft: getComputedStyle(nestedUnordered.querySelector(":scope > .markdown-list-item") as HTMLElement, "::before").left,
              markerWidth: getComputedStyle(nestedUnordered.querySelector(":scope > .markdown-list-item") as HTMLElement, "::before").width,
            }
          : null,
    };
  });

  assert.ok(nested.rootOrdered, `missing root ordered nested fixture list in ${theme}`);
  assert.ok(nested.nestedOrdered, `missing nested ordered list in ${theme}`);
  assert.ok(nested.nestedUnordered, `missing nested unordered list in ${theme}`);
  assert.strictEqual(nested.rootOrdered.markerDigitsVar || nested.rootOrdered.markerDigitsAttr || "1", "1", `root ordered nested fixture should stay single-digit in ${theme}`);
  assert.strictEqual(nested.nestedOrdered.markerDigitsVar || nested.nestedOrdered.markerDigitsAttr || "1", "1", `nested ordered fixture should stay single-digit in ${theme}`);
  assert.ok(parsePx(nested.rootOrdered.paddingLeft) > parsePx(nested.nestedOrdered.paddingLeft), `nested ordered list should reserve less space than root ordered list in ${theme}`);
  assert.ok(parsePx(nested.nestedUnordered.paddingLeft) > 0, `nested unordered list should reserve marker space in ${theme}`);
}

async function checkFootnotes(page: Page, theme: "light" | "dark"): Promise<void> {
  await streamFixture(page, "footnotes");
  await setTheme(page, theme);

  const footnotes = await page.evaluate(() => {
    const section = document.querySelector("#regression-root .footnotes") as HTMLElement | null;
    const item = document.querySelector("#regression-root .footnotes ol li") as HTMLElement | null;
    const backref = document.querySelector("#regression-root .footnotes .footnote-backref") as HTMLElement | null;
    if (!section || !item || !backref) return null;

    const sectionStyle = getComputedStyle(section);
    const itemStyle = getComputedStyle(item);
    const beforeStyle = getComputedStyle(item, "::before");
    const backrefStyle = getComputedStyle(backref);
    const bodyStyle = getComputedStyle(document.body);
    const htmlStyle = getComputedStyle(document.documentElement);
    const colorProbe = document.createElement("canvas").getContext("2d");
    const fallbackBackground = bodyStyle.backgroundColor !== "rgba(0, 0, 0, 0)" ? bodyStyle.backgroundColor : htmlStyle.backgroundColor;
    let resolvedItemColor = itemStyle.color;
    let resolvedBackrefColor = backrefStyle.color;
    let resolvedBackground = fallbackBackground;
    if (colorProbe) {
      colorProbe.fillStyle = itemStyle.color;
      resolvedItemColor = colorProbe.fillStyle;
      colorProbe.fillStyle = backrefStyle.color;
      resolvedBackrefColor = colorProbe.fillStyle;
      colorProbe.fillStyle = fallbackBackground;
      resolvedBackground = colorProbe.fillStyle;
    }

    return {
      section: {
        borderTopWidth: sectionStyle.borderTopWidth,
        marginTop: sectionStyle.marginTop,
        color: sectionStyle.color,
      },
      item: {
        color: itemStyle.color,
        fontSize: itemStyle.fontSize,
      },
      before: {
        content: beforeStyle.content,
        position: beforeStyle.position,
        fontSize: beforeStyle.fontSize,
      },
      backref: {
        color: resolvedBackrefColor,
        textDecorationLine: backrefStyle.textDecorationLine,
        textUnderlineOffset: backrefStyle.textUnderlineOffset,
        inlineStyle: backref.getAttribute("style") ?? "",
      },
      background: resolvedBackground,
      itemColor: resolvedItemColor,
    };
  });

  assert.ok(footnotes, `missing footnotes section for ${theme}`);
  assert.ok(parsePx(footnotes.section.borderTopWidth) >= 1, `footnotes section should keep a visible divider in ${theme}`);
  assert.ok(parsePx(footnotes.section.marginTop) >= 32, `footnotes section should keep top separation in ${theme}`);
  assert.ok(footnotes.before.content && footnotes.before.content !== "none", `footnote counter marker should render in ${theme}`);
  assert.strictEqual(footnotes.before.position, "absolute", `footnote counter marker should stay absolute in ${theme}`);
  assert.ok(parsePx(footnotes.item.fontSize) >= 12, `footnotes text should remain readable in ${theme}`);
  assert.ok(footnotes.backref.textDecorationLine.includes("underline"), `footnote backref should remain visibly underlined in ${theme}`);

  const itemColor = parseRgb(footnotes.itemColor);
  const backrefColor = parseRgb(footnotes.backref.color);
  const background = parseRgb(footnotes.background);
  assert.ok(itemColor && backrefColor && background, `expected parseable footnote colors in ${theme}`);
  assert.ok(contrastRatio(itemColor, background) >= 4.5, `footnote body contrast must stay readable in ${theme}`);
  assert.ok(
    footnotes.backref.inlineStyle.includes("color: var(--foreground)") || contrastRatio(backrefColor, background) >= 3,
    `footnote backref should keep an explicit readable styling contract in ${theme}`,
  );
}

async function checkNestedListCodeIndentation(page: Page, theme: "light" | "dark"): Promise<void> {
  await streamFixture(page, "list-code-nested");
  await setTheme(page, theme);

  const nestedCode = await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll("#regression-root .markdown-list-item-children pre[data-code-block='true']")) as HTMLElement[];
    return blocks.map((pre) => {
      const childContainer = pre.closest(".markdown-list-item-children") as HTMLElement | null;
      const code = pre.querySelector("code");
      const rect = pre.getBoundingClientRect();
      const containerRect = childContainer?.getBoundingClientRect();
      const text = code?.textContent ?? "";
      const lines = text.split("\n").filter((line) => line.length > 0);
      return {
        preLeft: rect.left,
        containerLeft: containerRect?.left ?? null,
        text,
        firstLine: lines[0] ?? "",
      };
    });
  });

  assert.strictEqual(nestedCode.length, 3, `expected three nested list code blocks in ${theme}`);
  nestedCode.forEach((block, index) => {
    assert.ok(block.containerLeft !== null, `nested code block ${index} should live under a list-item child container in ${theme}`);
    assert.ok(Math.abs(block.preLeft - (block.containerLeft ?? 0)) <= 2, `nested code block ${index} should align with its list-item child container in ${theme}`);
    assert.ok(!/^[ \t]{2,}\S/.test(block.firstLine), `nested code block ${index} should not keep phantom leading indentation in ${theme}`);
  });

  assert.strictEqual(nestedCode[0]?.firstLine, "const value = 1;", `ordered nested code should keep exact first line text in ${theme}`);
  assert.strictEqual(nestedCode[1]?.firstLine, 'echo "nested"', `bullet nested code should keep exact first line text in ${theme}`);
  assert.strictEqual(nestedCode[2]?.firstLine, "export const answer = 42;", `unordered nested code should keep exact first line text in ${theme}`);
}

async function run(): Promise<void> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await checkListGeometry(page, "light");
    await checkListGeometry(page, "dark");
    await checkFootnotes(page, "light");
    await checkFootnotes(page, "dark");
    await checkNestedListCodeIndentation(page, "light");
    await checkNestedListCodeIndentation(page, "dark");
    console.log("style invariants passed");
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
