import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

type Args = {
  update: boolean;
  url: string;
  snapshotPath: string;
};

type StyleEntry = {
  selector?: string;
  missing?: boolean;
  computed?: Record<string, string>;
  pseudo?: Record<string, Record<string, string>>;
};

type StyleCapture = Record<string, StyleEntry>;

type CapturePayload = {
  summary: unknown;
  invariants: Array<{ message: string }>;
  light: StyleCapture;
  dark: StyleCapture;
  listInventory: Array<{
    className: string;
    markerDigits: string | null;
    textPreview: string;
  }>;
  html: string;
  darkPalette: {
    bodyBackground: string;
    footnoteText: string;
    footnoteLink: string;
    footnoteBackref: string;
    rootFootnoteVar?: string;
  };
};

const MARKDOWN_SAMPLE = [
  "1. Ordered one",
  "2. Ordered two",
  "   - Nested bullet alpha",
  "   - Nested bullet beta",
  "3. Ordered three",
  "   1. Nested ordered one",
  "   2. Nested ordered two",
  "",
  "- Bullet alpha",
  "- Bullet beta",
  "  1. Bullet child ordered one",
  "  2. Bullet child ordered two",
  "- Bullet gamma",
  "",
  "List split paragraph.",
  "",
  "1. Ten",
  "2. Eleven",
  "3. Twelve",
  "4. Thirteen",
  "5. Fourteen",
  "6. Fifteen",
  "7. Sixteen",
  "8. Seventeen",
  "9. Eighteen",
  "10. Nineteen",
  "",
  "Footnote reference[^style].",
  "",
  "[^style]: Footnote body with a [source link](https://example.com).",
  "",
].join("\n");

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const out: Args = {
    update: false,
    url: "http://localhost:3000/regression/html/",
    snapshotPath: "tests/regression/snapshots/styles/list-footnotes.json",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--update") {
      out.update = true;
      continue;
    }
    if (arg === "--url" && args[i + 1]) {
      out.url = args[i + 1];
      i++;
      continue;
    }
    if (arg === "--snapshot" && args[i + 1]) {
      out.snapshotPath = args[i + 1];
      i++;
      continue;
    }
  }

  return out;
}

type ParsedColor = { r: number; g: number; b: number; a: number };

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function srgbLinearToGamma(value: number): number {
  const v = clamp01(value);
  if (v <= 0.0031308) return 12.92 * v;
  return 1.055 * v ** (1 / 2.4) - 0.055;
}

function parseColor(input: string): ParsedColor | null {
  const raw = input.trim();

  const rgb = raw.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)$/i);
  if (rgb) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: rgb[4] !== undefined ? Number(rgb[4]) : 1,
    };
  }

  const srgb = raw.match(/^color\(srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+))?\)$/i);
  if (srgb) {
    return {
      r: Math.round(clamp01(Number(srgb[1])) * 255),
      g: Math.round(clamp01(Number(srgb[2])) * 255),
      b: Math.round(clamp01(Number(srgb[3])) * 255),
      a: srgb[4] !== undefined ? clamp01(Number(srgb[4])) : 1,
    };
  }

  const oklab = raw.match(/^oklab\(\s*([0-9.]+)\s+([+-]?[0-9.]+)\s+([+-]?[0-9.]+)(?:\s*\/\s*([0-9.]+))?\s*\)$/i);
  if (oklab) {
    const l = Number(oklab[1]);
    const a = Number(oklab[2]);
    const b = Number(oklab[3]);
    const alpha = oklab[4] !== undefined ? clamp01(Number(oklab[4])) : 1;

    const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = l - 0.0894841775 * a - 1.291485548 * b;

    const l3 = l_ ** 3;
    const m3 = m_ ** 3;
    const s3 = s_ ** 3;

    const rLin = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
    const gLin = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
    const bLin = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

    return {
      r: Math.round(clamp01(srgbLinearToGamma(rLin)) * 255),
      g: Math.round(clamp01(srgbLinearToGamma(gLin)) * 255),
      b: Math.round(clamp01(srgbLinearToGamma(bLin)) * 255),
      a: alpha,
    };
  }

  return null;
}

function flattenOver(foreground: ParsedColor, background: ParsedColor): ParsedColor {
  const alpha = clamp01(foreground.a);
  if (alpha >= 0.999) {
    return { ...foreground, a: 1 };
  }
  const bgA = clamp01(background.a);
  const outA = alpha + bgA * (1 - alpha);
  if (outA <= 0) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  const r = (foreground.r * alpha + background.r * bgA * (1 - alpha)) / outA;
  const g = (foreground.g * alpha + background.g * bgA * (1 - alpha)) / outA;
  const b = (foreground.b * alpha + background.b * bgA * (1 - alpha)) / outA;
  return { r, g, b, a: outA };
}

function luminance(color: { r: number; g: number; b: number }): number {
  const channel = (n: number) => {
    const x = n / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(color.r);
  const g = channel(color.g);
  const b = channel(color.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (!fg || !bg) return null;
  const flattenedFg = flattenOver(fg, bg);
  const l1 = luminance(flattenedFg);
  const l2 = luminance(bg);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

function px(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function assertCaptureChecks(payload: CapturePayload): void {
  const missing = [...Object.entries(payload.light), ...Object.entries(payload.dark)].filter(([, value]) => value?.missing);
  if (missing.length > 0) {
    const ids = missing.map(([id]) => id).join(", ");
    throw new Error(
      `style targets missing: ${ids}\nlist inventory: ${JSON.stringify(payload.listInventory)}\nhtml sample: ${payload.html.slice(0, 4000)}`,
    );
  }

  if (payload.invariants.length > 0) {
    throw new Error(`regression harness invariants failed: ${payload.invariants.map((v) => v.message).join(" | ")}`);
  }

  const orderedOnePad = px(payload.light.orderedOneList?.computed?.["padding-left"]);
  const unorderedPad = px(payload.light.unorderedList?.computed?.["padding-left"]);
  const nestedOrderedPad = px(payload.light.nestedOrderedList?.computed?.["padding-left"]);
  const nestedUnorderedPad = px(payload.light.nestedUnorderedList?.computed?.["padding-left"]);
  const orderedOneMarkerWidth = px(payload.light.orderedOneItem?.pseudo?.["::before"]?.width);
  const unorderedMarkerWidth = px(payload.light.unorderedItem?.pseudo?.["::before"]?.width);
  const nestedOrderedMarkerWidth = px(payload.light.nestedOrderedItem?.pseudo?.["::before"]?.width);
  const nestedUnorderedMarkerWidth = px(payload.light.nestedUnorderedItem?.pseudo?.["::before"]?.width);
  const orderedTwoMarkerWidth = px(payload.light.orderedTwoItem?.pseudo?.["::before"]?.width);

  if (orderedOnePad === null || unorderedPad === null) {
    throw new Error("unable to read list padding-left values");
  }
  if (Math.abs(orderedOnePad - unorderedPad) > 0.75) {
    throw new Error(`ordered/unordered list padding drift: ${orderedOnePad}px vs ${unorderedPad}px`);
  }
  if (nestedOrderedPad === null || nestedUnorderedPad === null) {
    throw new Error("unable to read nested list padding-left values");
  }
  if (Math.abs(nestedOrderedPad - nestedUnorderedPad) > 0.75) {
    throw new Error(`nested ordered/unordered list padding drift: ${nestedOrderedPad}px vs ${nestedUnorderedPad}px`);
  }

  if (
    orderedOneMarkerWidth === null ||
    unorderedMarkerWidth === null ||
    nestedOrderedMarkerWidth === null ||
    nestedUnorderedMarkerWidth === null ||
    orderedTwoMarkerWidth === null
  ) {
    throw new Error("unable to read list marker widths");
  }
  if (Math.abs(orderedOneMarkerWidth - unorderedMarkerWidth) > 0.75) {
    throw new Error(`ordered/unordered one-digit marker width drift: ${orderedOneMarkerWidth}px vs ${unorderedMarkerWidth}px`);
  }
  if (Math.abs(nestedOrderedMarkerWidth - nestedUnorderedMarkerWidth) > 0.75) {
    throw new Error(
      `nested ordered/unordered one-digit marker width drift: ${nestedOrderedMarkerWidth}px vs ${nestedUnorderedMarkerWidth}px`,
    );
  }
  if (orderedTwoMarkerWidth <= orderedOneMarkerWidth + 3) {
    throw new Error(
      `two-digit ordered marker width did not expand enough: one-digit=${orderedOneMarkerWidth}px two-digit=${orderedTwoMarkerWidth}px`,
    );
  }

  const linkContrast = contrastRatio(payload.darkPalette.footnoteLink, payload.darkPalette.bodyBackground);
  const textContrast = contrastRatio(payload.darkPalette.footnoteText, payload.darkPalette.bodyBackground);
  const backrefContrast = contrastRatio(payload.darkPalette.footnoteBackref, payload.darkPalette.bodyBackground);

  if (linkContrast === null || textContrast === null || backrefContrast === null) {
    throw new Error(
      `unable to compute dark-mode footnote contrast: ${JSON.stringify({
        body: payload.darkPalette.bodyBackground,
        text: payload.darkPalette.footnoteText,
        link: payload.darkPalette.footnoteLink,
        backref: payload.darkPalette.footnoteBackref,
      })}`,
    );
  }
  if (textContrast < 4.5) {
    throw new Error(`dark footnote text contrast too low: ${textContrast.toFixed(2)}`);
  }
  if (linkContrast < 4.5) {
    throw new Error(
      `dark footnote link contrast too low: ${linkContrast.toFixed(2)} ` +
        JSON.stringify({
          body: payload.darkPalette.bodyBackground,
          link: payload.darkPalette.footnoteLink,
          footnoteText: payload.darkPalette.footnoteText,
          backref: payload.darkPalette.footnoteBackref,
          rootVar: payload.darkPalette.rootFootnoteVar,
          darkTarget: payload.dark.footnoteLink,
        }),
    );
  }
  if (backrefContrast < 4.5) {
    throw new Error(`dark footnote backref contrast too low: ${backrefContrast.toFixed(2)}`);
  }
}

function normalizeSnapshot(input: CapturePayload): CapturePayload {
  const trimDeep = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((v) => trimDeep(v));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = trimDeep(v);
      }
      return out;
    }
    if (typeof value === "string") return value.trim();
    return value;
  };
  return trimDeep(input) as CapturePayload;
}

function compareSnapshots(expected: unknown, actual: unknown, pathPrefix = "$"): string[] {
  if (typeof expected !== typeof actual) {
    return [`${pathPrefix}: type mismatch (${typeof expected} !== ${typeof actual})`];
  }
  if (expected === null || actual === null) {
    return expected === actual ? [] : [`${pathPrefix}: null mismatch`];
  }
  if (typeof expected === "string" && typeof actual === "string") {
    const expectedPx = expected.match(/^-?\d+(\.\d+)?px$/);
    const actualPx = actual.match(/^-?\d+(\.\d+)?px$/);
    if (expectedPx && actualPx) {
      const a = Number.parseFloat(expected);
      const b = Number.parseFloat(actual);
      if (Math.abs(a - b) <= 0.75) return [];
      return [`${pathPrefix}: px drift (${expected} !== ${actual})`];
    }
    return expected === actual ? [] : [`${pathPrefix}: value mismatch (${expected} !== ${actual})`];
  }
  if (typeof expected === "number" && typeof actual === "number") {
    return Math.abs(expected - actual) <= 0.001 ? [] : [`${pathPrefix}: number mismatch (${expected} !== ${actual})`];
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return [`${pathPrefix}: length mismatch (${expected.length} !== ${actual.length})`];
    }
    const errors: string[] = [];
    for (let i = 0; i < expected.length; i++) {
      errors.push(...compareSnapshots(expected[i], actual[i], `${pathPrefix}[${i}]`));
    }
    return errors;
  }
  if (typeof expected === "object" && typeof actual === "object") {
    const expectedObj = expected as Record<string, unknown>;
    const actualObj = actual as Record<string, unknown>;
    const keys = Array.from(new Set([...Object.keys(expectedObj), ...Object.keys(actualObj)])).sort();
    const errors: string[] = [];
    for (const key of keys) {
      if (!(key in expectedObj)) {
        errors.push(`${pathPrefix}.${key}: unexpected key`);
        continue;
      }
      if (!(key in actualObj)) {
        errors.push(`${pathPrefix}.${key}: missing key`);
        continue;
      }
      errors.push(...compareSnapshots(expectedObj[key], actualObj[key], `${pathPrefix}.${key}`));
    }
    return errors;
  }
  return expected === actual ? [] : [`${pathPrefix}: mismatch`];
}

async function main() {
  const args = parseArgs(process.argv);
  const repoRoot = path.resolve(__dirname, "..");
  const snapshotPath = path.resolve(repoRoot, args.snapshotPath);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => Boolean((window as any).__streammdxRegression), { timeout: 15_000 });

    await page.evaluate(async (sample) => {
      const api = (window as any).__streammdxRegression;
      let noMotion = document.getElementById("__streammdx-regression-no-motion");
      if (!noMotion) {
        noMotion = document.createElement("style");
        noMotion.id = "__streammdx-regression-no-motion";
        noMotion.textContent =
          "*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important;}";
        document.head.appendChild(noMotion);
      }
      await api.waitForReady();
      await api.appendAndFlush(sample);
      await api.finalizeAndFlush();
    }, MARKDOWN_SAMPLE);

    const payload = (await page.evaluate(async () => {
      const api = (window as any).__streammdxRegression;
      const lightTargets = [
        {
          id: "orderedOneList",
          selector: ".markdown-list.ordered[data-marker-digits=\"1\"]",
          properties: ["padding-left"],
        },
        {
          id: "unorderedList",
          selector: ".markdown-list.unordered[data-marker-digits=\"1\"]",
          properties: ["padding-left"],
        },
        {
          id: "orderedTwoList",
          selector: ".markdown-list.ordered[data-marker-digits=\"2\"]",
          properties: ["padding-left"],
        },
        {
          id: "nestedOrderedList",
          selector: ".markdown-list.ordered[data-list-depth=\"1\"][data-marker-digits=\"1\"]",
          properties: ["padding-left"],
        },
        {
          id: "nestedUnorderedList",
          selector: ".markdown-list.unordered[data-list-depth=\"1\"][data-marker-digits=\"1\"]",
          properties: ["padding-left"],
        },
        {
          id: "orderedOneItem",
          selector: ".markdown-list.ordered[data-marker-digits=\"1\"] > .markdown-list-item:first-child",
          properties: [],
          pseudo: { before: ["width", "padding-right", "text-align", "content"] },
        },
        {
          id: "unorderedItem",
          selector: ".markdown-list.unordered[data-marker-digits=\"1\"] > .markdown-list-item:first-child",
          properties: [],
          pseudo: { before: ["width", "justify-content", "content"] },
        },
        {
          id: "orderedTwoItem",
          selector: ".markdown-list.ordered[data-marker-digits=\"2\"] > .markdown-list-item:first-child",
          properties: [],
          pseudo: { before: ["width", "padding-right", "text-align", "content"] },
        },
        {
          id: "nestedOrderedItem",
          selector: ".markdown-list.ordered[data-list-depth=\"1\"][data-marker-digits=\"1\"] > .markdown-list-item:first-child",
          properties: [],
          pseudo: { before: ["width", "padding-right", "text-align", "content"] },
        },
        {
          id: "nestedUnorderedItem",
          selector: ".markdown-list.unordered[data-list-depth=\"1\"][data-marker-digits=\"1\"] > .markdown-list-item:first-child",
          properties: [],
          pseudo: { before: ["width", "justify-content", "content"] },
        },
      ];
      const light = api.getComputedStyles(lightTargets);
      const summary = api.getSummary();
      const invariants = api.getInvariantViolations();

      document.documentElement.classList.add("dark");
      document.body.classList.add("dark");
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const darkTargets = [
        {
          id: "footnoteContainer",
          selector: ".footnotes",
          properties: ["border-top-color", "color"],
        },
        {
          id: "footnoteItem",
          selector: ".footnotes ol li:first-child",
          properties: ["color", "font-size"],
        },
        {
          id: "footnoteLink",
          selector: ".footnotes ol li:first-child a",
          properties: ["color", "text-decoration-color", "--footnote-link", "--tw-prose-links"],
        },
        {
          id: "footnoteBackref",
          selector: ".footnotes .footnote-backref",
          properties: ["color", "opacity"],
        },
      ];
      const dark = api.getComputedStyles(darkTargets);
      const listInventory = Array.from(document.querySelectorAll(".markdown-list")).map((el) => ({
        className: (el as HTMLElement).className,
        markerDigits: (el as HTMLElement).getAttribute("data-marker-digits"),
        textPreview: ((el as HTMLElement).textContent ?? "").slice(0, 120),
      }));
      const html = api.getHtml();

      const body = getComputedStyle(document.body);
      const footnoteTextEl = document.querySelector(".footnotes ol li:first-child");
      const footnoteLinkEl = document.querySelector(".footnotes ol li:first-child a");
      const footnoteBackrefEl = document.querySelector(".footnotes .footnote-backref");
      const footnoteText = footnoteTextEl
        ? (() => {
            const probe = document.createElement("span");
            probe.style.position = "fixed";
            probe.style.opacity = "0";
            probe.style.pointerEvents = "none";
            probe.style.color = getComputedStyle(footnoteTextEl).color;
            document.body.appendChild(probe);
            const resolved = getComputedStyle(probe).color;
            probe.remove();
            return resolved;
          })()
        : "";
      const footnoteLink = footnoteLinkEl
        ? (() => {
            const probe = document.createElement("span");
            probe.style.position = "fixed";
            probe.style.opacity = "0";
            probe.style.pointerEvents = "none";
            probe.style.color = getComputedStyle(footnoteLinkEl).color;
            document.body.appendChild(probe);
            const resolved = getComputedStyle(probe).color;
            probe.remove();
            return resolved;
          })()
        : "";
      const footnoteBackref = footnoteBackrefEl
        ? (() => {
            const probe = document.createElement("span");
            probe.style.position = "fixed";
            probe.style.opacity = "0";
            probe.style.pointerEvents = "none";
            probe.style.color = getComputedStyle(footnoteBackrefEl).color;
            document.body.appendChild(probe);
            const resolved = getComputedStyle(probe).color;
            probe.remove();
            return resolved;
          })()
        : "";
      const bodyBackground = (() => {
        const probe = document.createElement("span");
        probe.style.position = "fixed";
        probe.style.opacity = "0";
        probe.style.pointerEvents = "none";
        probe.style.color = body.backgroundColor;
        document.body.appendChild(probe);
        const resolved = getComputedStyle(probe).color;
        probe.remove();
        return resolved;
      })();

      return {
        summary,
        invariants,
        light,
        dark,
        listInventory,
        html,
        darkPalette: {
          bodyBackground,
          footnoteText,
          footnoteLink,
          footnoteBackref,
          rootFootnoteVar: getComputedStyle(document.documentElement).getPropertyValue("--footnote-link"),
        },
      };
    })) as CapturePayload;

    const normalized = normalizeSnapshot(payload);
    assertCaptureChecks(normalized);

    if (args.update) {
      await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
      await fs.writeFile(snapshotPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
      process.stdout.write(`[stream-mdx] updated style regression snapshot: ${path.relative(repoRoot, snapshotPath)}\n`);
      return;
    }

    const expectedRaw = await fs.readFile(snapshotPath, "utf8");
    const expected = JSON.parse(expectedRaw) as CapturePayload;
    const errors = compareSnapshots(expected, normalized);
    if (errors.length > 0) {
      const artifactDir = path.resolve(repoRoot, "tmp/regression-artifacts");
      await fs.mkdir(artifactDir, { recursive: true });
      const receivedPath = path.resolve(artifactDir, "styles-received.json");
      const screenshotPath = path.resolve(artifactDir, "styles-received.png");
      await fs.writeFile(receivedPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
      await page.screenshot({ path: screenshotPath, fullPage: true });
      throw new Error(
        `[stream-mdx] style regression mismatch (${errors.length} differences).\n` +
          `first: ${errors[0]}\n` +
          `received snapshot: ${path.relative(repoRoot, receivedPath)}\n` +
          `screenshot: ${path.relative(repoRoot, screenshotPath)}`,
      );
    }
    process.stdout.write(`[stream-mdx] style regression passed (${path.relative(repoRoot, snapshotPath)})\n`);
  } finally {
    await page.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
