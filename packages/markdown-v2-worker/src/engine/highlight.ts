import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { type BundledLanguage, type BundledTheme, type Highlighter, type SpecialLanguage, bundledLanguages, bundledThemes, createHighlighter } from "shiki";
import type {
  DiffBlock,
  DiffKind,
  DiffLine,
  DiffLineKind,
  ThemedLine,
  ThemedToken,
  TokenLineV1,
  TokenSpan,
  TokenStyle,
} from "@stream-mdx/core";
import type {
  DiffCursorState,
  DiffLineInfo,
  ShikiThemedToken,
  ShikiTokenStyle,
} from "./types";

export type CodeThemePair = { dark: BundledTheme; light: BundledTheme };
export const DEFAULT_CODE_HIGHLIGHT_THEMES: CodeThemePair = {
  dark: "github-dark",
  light: "github-light",
};
export const CODE_HIGHLIGHT_THEMES = DEFAULT_CODE_HIGHLIGHT_THEMES;

export function isBundledTheme(theme: string): theme is BundledTheme {
  return Object.prototype.hasOwnProperty.call(bundledThemes, theme);
}

export async function ensureThemeLoaded(
  highlighter: SharedHighlighter,
  theme: string,
): Promise<void> {
  if (!isBundledTheme(theme)) return;
  const loaded = highlighter.getLoadedThemes();
  if (!loaded.includes(theme)) {
    await highlighter.loadTheme(theme);
  }
}

export interface ResolvedHighlightThemesResult {
  themes: CodeThemePair;
  errors: Error[];
}

export async function resolveHighlightThemes(
  highlighter: SharedHighlighter | null,
  requestedThemes?: { light?: string; dark?: string } | null,
): Promise<ResolvedHighlightThemesResult> {
  const errors: Error[] = [];
  let light: BundledTheme = DEFAULT_CODE_HIGHLIGHT_THEMES.light;
  let dark: BundledTheme = DEFAULT_CODE_HIGHLIGHT_THEMES.dark;

  if (requestedThemes && typeof requestedThemes === "object") {
    if (requestedThemes.light !== undefined) {
      if (typeof requestedThemes.light === "string" && isBundledTheme(requestedThemes.light)) {
        light = requestedThemes.light;
      } else {
        errors.push(new Error(`Unknown code theme '${requestedThemes.light}' for variant 'light'`));
      }
    }
    if (requestedThemes.dark !== undefined) {
      if (typeof requestedThemes.dark === "string" && isBundledTheme(requestedThemes.dark)) {
        dark = requestedThemes.dark;
      } else {
        errors.push(new Error(`Unknown code theme '${requestedThemes.dark}' for variant 'dark'`));
      }
    }
  }

  if (highlighter) {
    if (light !== DEFAULT_CODE_HIGHLIGHT_THEMES.light) {
      try {
        await ensureThemeLoaded(highlighter, light);
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
        light = DEFAULT_CODE_HIGHLIGHT_THEMES.light;
      }
    }
    if (dark !== DEFAULT_CODE_HIGHLIGHT_THEMES.dark) {
      try {
        await ensureThemeLoaded(highlighter, dark);
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
        dark = DEFAULT_CODE_HIGHLIGHT_THEMES.dark;
      }
    }
  }

  return {
    themes: { dark, light },
    errors,
  };
}

export interface CachedHighlight {
  html?: string;
  tokenLines?: Array<TokenLineV1 | null>;
  lang: string;
}

const MAX_SHARED_HIGHLIGHT_CACHE_ENTRIES = 500;
const sharedHighlightCache = new Map<string, CachedHighlight>();

export function getSharedHighlightCacheKey(
  lang: string,
  themes: { light: string; dark: string },
  code: string,
): string {
  return `${themes.light}::${themes.dark}::${lang}::${code}`;
}

export function getCachedHighlight(
  lang: string,
  themes: { light: string; dark: string },
  code: string,
): CachedHighlight | undefined {
  return sharedHighlightCache.get(getSharedHighlightCacheKey(lang, themes, code));
}

export function setCachedHighlight(
  lang: string,
  themes: { light: string; dark: string },
  code: string,
  entry: CachedHighlight,
): void {
  const key = getSharedHighlightCacheKey(lang, themes, code);
  if (sharedHighlightCache.size >= MAX_SHARED_HIGHLIGHT_CACHE_ENTRIES) {
    const first = sharedHighlightCache.keys().next().value;
    if (typeof first === "string") {
      sharedHighlightCache.delete(first);
    }
  }
  sharedHighlightCache.set(key, entry);
}

export function clearSharedHighlightCache(): void {
  sharedHighlightCache.clear();
}

export const FONT_STYLE_ITALIC = 1;
export const FONT_STYLE_BOLD = 2;
export const FONT_STYLE_UNDERLINE = 4;
export const FONT_STYLE_STRIKETHROUGH = 8;

export type SharedHighlighter = Highlighter;

let sharedHighlighterPromise: Promise<SharedHighlighter> | null = null;
let sharedHighlighter: SharedHighlighter | null = null;

function isSupportedLanguage(language: string): language is BundledLanguage | SpecialLanguage {
  return language === "text" || language === "plaintext" || language === "txt" || language === "ansi"
    || Object.prototype.hasOwnProperty.call(bundledLanguages, language);
}
export async function getSharedHighlighter(prewarmLangs: string[] = []): Promise<SharedHighlighter> {
  if (!sharedHighlighterPromise) {
    const coreLangs = ["javascript", "typescript", "json", "text", "markdown", "diff"];
    const initialLangs = Array.from(new Set([...coreLangs, ...prewarmLangs]));
    sharedHighlighterPromise = createHighlighter({
      engine: createJavaScriptRegexEngine(),
      langs: initialLangs,
      themes: ["github-dark", "github-light"],
    }).then(
      (h) => {
        sharedHighlighter = h;
        return h;
      },
      (error: unknown) => {
        sharedHighlighterPromise = null;
        throw error;
      },
    );
  }
  const highlighter = await sharedHighlighterPromise;
  if (prewarmLangs.length > 0) {
    const loaded = new Set(highlighter.getLoadedLanguages());
    const toLoad = prewarmLangs.filter((l) => !loaded.has(l));
    if (toLoad.length > 0) {
      await Promise.all(
        toLoad.map((l) =>
          (isSupportedLanguage(l) ? highlighter.loadLanguage(l) : Promise.reject(new Error(`Unsupported language ${l}`))).catch((err) => {
            console.warn(`Failed to prewarm language ${l}:`, err);
          }),
        ),
      );
    }
  }
  return highlighter;
}

export async function resolveHighlightLanguage(
  highlighter: SharedHighlighter | null,
  requestedLanguage: string,
): Promise<BundledLanguage | SpecialLanguage> {
  if (!highlighter) return "text";
  if (!isSupportedLanguage(requestedLanguage)) {
    console.warn(`Unsupported language ${requestedLanguage}, falling back to text`);
    return "text";
  }
  const loadedLangs = highlighter.getLoadedLanguages();
  if (!loadedLangs.includes(requestedLanguage)) {
    try {
      await highlighter.loadLanguage(requestedLanguage);
    } catch (loadError) {
      console.warn(`Failed to load language ${requestedLanguage}, falling back to text:`, loadError);
    }
  }
  const nextLangs = highlighter.getLoadedLanguages();
  return nextLangs.includes(requestedLanguage) ? requestedLanguage : "text";
}

export function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderShikiToken(token: ShikiThemedToken): string {
  const dark = token.variants.dark;
  const light = token.variants.light;
  const styles: string[] = [];

  if (dark?.color) {
    styles.push(`--shiki-dark:${dark.color}`);
  }
  if (light?.color) {
    styles.push(`--shiki-light:${light.color}`);
  }

  const darkFs = dark?.fontStyle ?? 0;
  const lightFs = light?.fontStyle ?? 0;

  if (darkFs & FONT_STYLE_ITALIC) styles.push("--shiki-dark-font-style:italic");
  if (lightFs & FONT_STYLE_ITALIC) styles.push("--shiki-light-font-style:italic");
  if (darkFs & FONT_STYLE_BOLD) styles.push("--shiki-dark-font-weight:bold");
  if (lightFs & FONT_STYLE_BOLD) styles.push("--shiki-light-font-weight:bold");
  if (darkFs & FONT_STYLE_UNDERLINE) styles.push("--shiki-dark-text-decoration:underline");
  if (lightFs & FONT_STYLE_UNDERLINE) styles.push("--shiki-light-text-decoration:underline");
  if (darkFs & FONT_STYLE_STRIKETHROUGH) styles.push("--shiki-dark-text-decoration:line-through");
  if (lightFs & FONT_STYLE_STRIKETHROUGH) styles.push("--shiki-light-text-decoration:line-through");

  const styleAttr = styles.length > 0 ? ` style="${styles.join(";")}"` : "";
  return `<span${styleAttr}>${escapeHtmlText(token.content)}</span>`;
}

export function hasOnlyWhitespace(content: string): boolean {
  return /^[\t ]+$/.test(content);
}

export function sameShikiTokenStyle(a: ShikiThemedToken, b: ShikiThemedToken): boolean {
  const variantKeys = new Set([...Object.keys(a.variants), ...Object.keys(b.variants)]);
  for (const key of variantKeys) {
    const aStyle = a.variants[key];
    const bStyle = b.variants[key];
    if (aStyle?.color !== bStyle?.color) return false;
    if ((aStyle?.fontStyle ?? 0) !== (bStyle?.fontStyle ?? 0)) return false;
  }
  return true;
}

export function mergeWhitespaceTokens(tokens: ShikiThemedToken[][]): ShikiThemedToken[][] {
  return tokens.map((lineTokens) => {
    if (lineTokens.length <= 1) return lineTokens;

    const redistributed: ShikiThemedToken[] = [];
    let pendingWhitespace = "";

    for (let i = 0; i < lineTokens.length; i += 1) {
      const token = lineTokens[i];
      if (hasOnlyWhitespace(token.content)) {
        pendingWhitespace += token.content;
        continue;
      }

      const normalizedToken: ShikiThemedToken = pendingWhitespace
        ? {
            content: `${pendingWhitespace}${token.content}`,
            variants: token.variants,
          }
        : token;
      pendingWhitespace = "";

      const previous = redistributed[redistributed.length - 1];
      if (previous && sameShikiTokenStyle(previous, normalizedToken)) {
        previous.content += normalizedToken.content;
      } else {
        redistributed.push({
          content: normalizedToken.content,
          variants: normalizedToken.variants,
        });
      }
    }

    if (pendingWhitespace) {
      const previous = redistributed[redistributed.length - 1];
      if (previous) {
        previous.content += pendingWhitespace;
      } else {
        redistributed.push({ content: pendingWhitespace, variants: {} });
      }
    }

    return redistributed;
  });
}

export function renderShikiLines(tokens: ShikiThemedToken[][]): Array<string | null> {
  const merged = mergeWhitespaceTokens(tokens);
  return merged.map((lineTokens) => lineTokens.map(renderShikiToken).join(""));
}

export function detectDiffLanguage(lang: string, meta: Record<string, unknown>): { isDiff: boolean; diffLang: string; baseLang: string | null } {
  const normalized = (lang || "").trim().toLowerCase();
  if (!normalized) {
    return { isDiff: false, diffLang: "diff", baseLang: null };
  }
  if (normalized === "diff" || normalized === "patch" || normalized === "udiff") {
    const baseCandidate = typeof meta.base === "string" ? meta.base : typeof meta.lang === "string" ? meta.lang : null;
    return { isDiff: true, diffLang: normalized, baseLang: baseCandidate };
  }
  if (normalized.startsWith("diff-")) {
    const base = normalized.slice(5).trim();
    return { isDiff: true, diffLang: normalized, baseLang: base || null };
  }
  if (normalized.endsWith("-diff")) {
    const base = normalized.slice(0, -5).trim();
    return { isDiff: true, diffLang: normalized, baseLang: base || null };
  }
  if (Boolean(meta.diff)) {
    return { isDiff: true, diffLang: "diff", baseLang: normalized };
  }
  return { isDiff: false, diffLang: normalized, baseLang: null };
}

export function parseDiffHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
  if (!match) return null;
  return {
    oldStart: Number.parseInt(match[1], 10),
    newStart: Number.parseInt(match[3], 10),
  };
}

export function isDiffMetaLine(line: string): boolean {
  if (!line) return false;
  return (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file ") ||
    line.startsWith("deleted file ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ")
  );
}

export function parseUnifiedDiffLine(line: string, cursor: DiffCursorState): DiffLineInfo {
  if (line.startsWith("@@")) {
    const header = parseDiffHunkHeader(line);
    if (header) {
      cursor.oldLine = header.oldStart;
      cursor.newLine = header.newStart;
    }
    return { text: line, kind: "hunk", prefix: "", content: line, oldNo: null, newNo: null, raw: line, hunkHeader: true };
  }
  if (line.startsWith("--- ") || line.startsWith("+++ ") || isDiffMetaLine(line)) {
    return { text: line, kind: "meta", prefix: "", content: line, oldNo: null, newNo: null, raw: line };
  }
  if (line.startsWith("+")) {
    if (line.startsWith("+++")) {
      return { text: line, kind: "meta", prefix: "", content: line, oldNo: null, newNo: null, raw: line };
    }
    const newNo = cursor.newLine;
    if (cursor.newLine !== null) cursor.newLine += 1;
    return { text: line, kind: "add", prefix: "+", content: line.slice(1), oldNo: null, newNo, raw: line };
  }
  if (line.startsWith("-")) {
    if (line.startsWith("---")) {
      return { text: line, kind: "meta", prefix: "", content: line, oldNo: null, newNo: null, raw: line };
    }
    const oldNo = cursor.oldLine;
    if (cursor.oldLine !== null) cursor.oldLine += 1;
    return { text: line, kind: "remove", prefix: "-", content: line.slice(1), oldNo, newNo: null, raw: line };
  }
  if (line.startsWith(" ")) {
    const oldNo = cursor.oldLine;
    const newNo = cursor.newLine;
    if (cursor.oldLine !== null) cursor.oldLine += 1;
    if (cursor.newLine !== null) cursor.newLine += 1;
    return { text: line, kind: "context", prefix: " ", content: line.slice(1), oldNo, newNo, raw: line };
  }
  return { text: line, kind: "meta", prefix: "", content: line, oldNo: null, newNo: null, raw: line };
}

export function normalizeDiffPath(value: string | null): string | null {
  if (!value) return null;
  let path = value.trim();
  if (!path || path === "/dev/null") return null;
  if (path.startsWith("a/") || path.startsWith("b/")) {
    path = path.slice(2);
  }
  return path || null;
}

export function extractDiffFilePath(line: string): string | null {
  if (line.startsWith("diff --git")) {
    const match = line.match(/^diff --git\s+(\S+)\s+(\S+)/);
    if (match) {
      return normalizeDiffPath(match[2]) || normalizeDiffPath(match[1]);
    }
  }
  if (line.startsWith("+++ ")) {
    return normalizeDiffPath(line.slice(4));
  }
  if (line.startsWith("--- ")) {
    return normalizeDiffPath(line.slice(4));
  }
  return null;
}

export function looksLikeUnifiedDiff(lines: string[]): boolean {
  if (lines.length === 0) return false;
  for (const line of lines) {
    if (line.startsWith("diff --git") || line.startsWith("@@") || line.startsWith("+++ ") || line.startsWith("--- ")) {
      return true;
    }
  }
  return false;
}

export function guessLanguageFromPath(filePath: string | null): string | null {
  if (!filePath) return null;
  const parts = filePath.split(/[\\/]/);
  const file = parts[parts.length - 1] ?? "";
  const dot = file.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = file.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "jsx":
      return "jsx";
    case "tsx":
      return "tsx";
    case "json":
      return "json";
    case "md":
    case "markdown":
      return "markdown";
    case "py":
      return "python";
    case "rb":
      return "ruby";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "java":
      return "java";
    case "c":
      return "c";
    case "cpp":
    case "cc":
    case "cxx":
      return "cpp";
    case "cs":
      return "csharp";
    case "html":
      return "html";
    case "css":
      return "css";
    case "scss":
      return "scss";
    case "yaml":
    case "yml":
      return "yaml";
    case "sh":
    case "bash":
    case "zsh":
      return "bash";
    default:
      return null;
  }
}

export function guessLanguageFromDiffLines(lines: string[]): string | null {
  for (const line of lines) {
    const filePath = extractDiffFilePath(line);
    if (filePath) {
      const guessed = guessLanguageFromPath(filePath);
      if (guessed) return guessed;
    }
  }
  return null;
}

export function toDiffLineKind(kind: DiffKind): DiffLineKind {
  if (kind === "remove") return "del";
  return kind;
}

export function toThemedLine(tokenLine: TokenLineV1 | null, theme: keyof typeof CODE_HIGHLIGHT_THEMES): ThemedLine | null {
  if (!tokenLine) return null;
  return tokenLine.spans.map((span) => {
    const style = span.s ?? span.v?.[theme];
    const token: ThemedToken = { content: span.t };
    if (style?.fg !== undefined) token.color = style.fg;
    if (style?.fs !== undefined) token.fontStyle = style.fs;
    return token;
  });
}

export function stripPrefixFromThemedLine(tokens: ThemedLine | null, prefix: string): ThemedLine | null {
  if (!tokens || !prefix) return tokens;
  if (tokens.length === 0) return tokens;
  const first = tokens[0];
  if (!first || !first.content.startsWith(prefix)) return tokens;
  const rest = first.content.slice(prefix.length);
  if (rest.length === 0) {
    return tokens.slice(1);
  }
  return [{ ...first, content: rest }, ...tokens.slice(1)];
}

export function buildDiffBlocksFromLines(
  lines: DiffLineInfo[],
  rawLines: string[],
  tokenLines: Array<TokenLineV1 | null> | null,
  defaultLanguage: string | null = null,
): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  let current: DiffBlock | null = null;
  let currentRaw: string[] = [];
  let additions = 0;
  let deletions = 0;

  const finalize = () => {
    if (!current) return;
    current.additions = additions;
    current.deletions = deletions;
    if (currentRaw.length > 0) {
      current.unified = currentRaw.join("\n");
    }
    blocks.push(current);
    current = null;
    currentRaw = [];
    additions = 0;
    deletions = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const raw = rawLines[i] ?? line.text ?? line.raw;
    const filePath = extractDiffFilePath(raw);

    if (raw.startsWith("diff --git")) {
      finalize();
    }
    if (!current) {
      current = {
        kind: "diff",
        filePath: filePath ?? null,
        language: filePath ? guessLanguageFromPath(filePath) ?? defaultLanguage : defaultLanguage,
        lines: [],
        additions: null,
        deletions: null,
        unified: null,
      };
    } else if (filePath && !current.filePath) {
      current.filePath = filePath;
      if (!current.language) {
        current.language = guessLanguageFromPath(filePath) ?? defaultLanguage;
      }
    }

    if (line.kind === "add") additions += 1;
    if (line.kind === "remove") deletions += 1;

    let themed = tokenLines ? toThemedLine(tokenLines[i] ?? null, "dark") : null;
    if (line.kind === "add" || line.kind === "remove" || line.kind === "context") {
      themed = stripPrefixFromThemedLine(themed, line.prefix ?? "");
    }

    const entry: DiffLine = {
      kind: toDiffLineKind(line.kind),
      oldNo: line.oldNo ?? null,
      newNo: line.newNo ?? null,
      raw,
      tokens: themed ?? null,
    };
    current.lines.push(entry);
    currentRaw.push(raw);
  }

  finalize();
  return blocks;
}

export function toTokenStyle(style: ShikiTokenStyle | undefined): TokenStyle | undefined {
  if (!style) return undefined;
  const fg = typeof style.color === "string" ? style.color : undefined;
  const fs = typeof style.fontStyle === "number" && style.fontStyle > 0 ? style.fontStyle : undefined;
  if (!fg && !fs) return undefined;
  const result: TokenStyle = {};
  if (fg !== undefined) result.fg = fg;
  if (fs !== undefined) result.fs = fs;
  return result;
}

export function toTokenSpan(token: ShikiThemedToken): TokenSpan {
  const dark = toTokenStyle(token.variants.dark);
  const light = toTokenStyle(token.variants.light);
  const span: TokenSpan = { t: token.content };
  if (dark || light) {
    span.v = {};
    if (dark) span.v.dark = dark;
    if (light) span.v.light = light;
  }
  return span;
}

export function renderTokenLines(tokens: ShikiThemedToken[][]): Array<TokenLineV1 | null> {
  return tokens.map((lineTokens) => ({
    spans: lineTokens.map((token) => toTokenSpan(token)),
  }));
}

export async function tokenizeDiffRun(
  lines: DiffLineInfo[],
  language: string,
  grammarState: unknown,
  highlighter: SharedHighlighter,
  themes: CodeThemePair = DEFAULT_CODE_HIGHLIGHT_THEMES,
): Promise<{ tokenLines: Array<TokenLineV1 | null>; grammarState: unknown }> {
  if (lines.length === 0) {
    return { tokenLines: [], grammarState };
  }
  const text = lines.map((line) => line.raw).join("\n");
  // Shiki 1.29 forwards this continuation option to codeToTokensBase, although
  // its multi-theme options declaration omits it.
  const options = {
    lang: isSupportedLanguage(language) ? language : "text",
    themes,
    grammarState,
  };
  const rawTokens = highlighter.codeToTokensWithThemes(text, options);
  const nextGrammarState = highlighter.getLastGrammarState(rawTokens);
  return {
    tokenLines: renderTokenLines(rawTokens),
    grammarState: nextGrammarState,
  };
}

export async function buildDiffTokenLines(
  lines: DiffLineInfo[],
  language: string,
  grammarState: {
    add?: unknown;
    remove?: unknown;
    context?: unknown;
  },
  highlighter: SharedHighlighter,
  themes: CodeThemePair = DEFAULT_CODE_HIGHLIGHT_THEMES,
): Promise<{ tokenLines: Array<TokenLineV1 | null>; grammarState: typeof grammarState }> {
  if (lines.length === 0) {
    return { tokenLines: [], grammarState };
  }
  const tokenLines: Array<TokenLineV1 | null> = new Array(lines.length).fill(null);
  let currentKind: DiffLineInfo["kind"] | null = null;
  let currentRun: DiffLineInfo[] = [];
  let startIndex = 0;

  const flush = async () => {
    if (!currentKind || currentRun.length === 0) return;
    const stateKey = currentKind === "add" ? "add" : currentKind === "remove" ? "remove" : "context";
    const priorState = grammarState[stateKey];
    const { tokenLines: runTokens, grammarState: nextState } = await tokenizeDiffRun(
      currentRun,
      language,
      priorState,
      highlighter,
      themes,
    );
    grammarState[stateKey] = nextState;
    for (let i = 0; i < runTokens.length; i += 1) {
      tokenLines[startIndex + i] = runTokens[i] ?? null;
    }
    currentRun = [];
    currentKind = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const info = lines[i];
    if (info.kind === "meta" || info.hunkHeader) {
      await flush();
      tokenLines[i] = null;
      continue;
    }
    if (currentKind !== info.kind) {
      await flush();
      currentKind = info.kind;
      startIndex = i;
    }
    currentRun.push(info);
  }
  await flush();
  return { tokenLines, grammarState };
}

export function enhanceHighlightedHtml(html: string, language: string): string {
  if (!html) return html;

  const lineRegex = /<span class="line">([\s\S]*?)<\/span>/g;
  let lineNumber = 1;
  const processed = html.replace(lineRegex, (_match, lineContent) => {
    const lineAttr = ` data-line="${lineNumber}"`;
    lineNumber++;
    return `<span class="line"${lineAttr}>${lineContent}</span>`;
  });

  const langClass = `language-${language}`;
  return processed.replace(/<code([^>]*)>/, (_match, attrs) => {
    const existingAttrs = parseAttributeString(attrs);
    const existingClass = existingAttrs.class || "";

    const classes = existingClass.split(" ").filter(Boolean);
    if (!classes.includes(langClass)) {
      classes.push(langClass);
    }
    existingAttrs.class = classes.join(" ");

    existingAttrs["data-language"] = language;
    return `<code${serializeAttributes(existingAttrs)}>`;
  });
}

export function parseAttributeString(fragment: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!fragment) return attrs;
  const regex = /([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;

  while (true) {
    match = regex.exec(fragment);
    if (match === null) break;
    attrs[match[1]] = match[2];
  }

  return attrs;
}

export function serializeAttributes(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${value}"`)
    .join("");
}

export function sanitizeShikiStyle(style: string | undefined): string | undefined {
  const sanitized: string[] = [];

  if (style) {
    const declarations = style.split(";");
    for (const decl of declarations) {
      const trimmed = decl.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("--shiki-dark-bg:") || trimmed.startsWith("--shiki-light-bg:")) {
        continue;
      }
      if (trimmed.startsWith("background-color:")) {
        continue;
      }
      sanitized.push(trimmed);
    }
  }

  return sanitized.length > 0 ? sanitized.join("; ") : undefined;
}

export function dedentFencedCodeByClosingIndent(fencedRaw: string, extractedCode: string): string {
  if (!fencedRaw || !extractedCode) {
    return extractedCode;
  }
  const lines = fencedRaw.split("\n");
  if (lines.length < 2) {
    return extractedCode;
  }
  const lastLine = lines[lines.length - 1] ?? "";
  const match = lastLine.match(/^([ \t]+)(?:```|~~~)/);
  if (!match) {
    return extractedCode;
  }
  const indentPrefix = match[1];
  if (!indentPrefix) {
    return extractedCode;
  }
  const codeLines = extractedCode.split("\n");
  const dedented = codeLines.map((line) => stripIndentPrefix(line, indentPrefix));
  return dedented.join("\n");
}

export function stripIndentPrefix(line: string, prefix: string): string {
  if (!line || !prefix) {
    return line;
  }
  if (line.startsWith(prefix)) {
    return line.slice(prefix.length);
  }
  const targetCols = measureIndentColumns(prefix);
  let cols = 0;
  let idx = 0;
  while (idx < line.length && cols < targetCols) {
    const ch = line[idx];
    if (ch === " ") {
      cols += 1;
      idx += 1;
    } else if (ch === "\t") {
      cols += 4 - (cols % 4);
      idx += 1;
    } else {
      break;
    }
  }
  if (cols >= targetCols) {
    return line.slice(idx);
  }
  return line.replace(/^[ \t]+/, "");
}

export function measureIndentColumns(value: string): number {
  let columns = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "\t") {
      columns += 4 - (columns % 4);
    } else if (ch === " ") {
      columns += 1;
    } else {
      break;
    }
  }
  return columns;
}
