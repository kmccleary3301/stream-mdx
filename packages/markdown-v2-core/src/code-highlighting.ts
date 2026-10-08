export type HighlightedLine = string | null;

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n?/g, "\n");
}

const OPEN_FENCE_REGEX = /^( {0,3})(`{3,}|~{3,})(.*)$/;
export function stripCodeFence(raw: string): { code: string; info: string; hadFence: boolean } {
  if (!raw) {
    return { code: "", info: "", hadFence: false };
  }
  const normalized = normalizeNewlines(raw);
  const lines = normalized.split("\n");
  if (lines.length === 0) {
    return { code: normalized, info: "", hadFence: false };
  }

  const firstLine = lines[0];
  const openMatch = firstLine.match(OPEN_FENCE_REGEX);
  if (!openMatch) {
    return { code: normalized, info: "", hadFence: false };
  }

  const indentCount = openMatch[1].length;
  const fenceChar = openMatch[2][0];
  const fenceLen = openMatch[2].length;
  const info = openMatch[3].trim();

  let endIndex = -1;
  const closeRegex = new RegExp(`^( {0,3})${fenceChar === "`" ? "\\`" : "~"}{${fenceLen},}\\s*$`);
  for (let i = lines.length - 1; i > 0; i--) {
    if (closeRegex.test(lines[i])) {
      endIndex = i;
      break;
    }
  }

  const rawCodeLines = endIndex > 0 ? lines.slice(1, endIndex) : lines.slice(1);
  const codeLines = indentCount > 0
    ? rawCodeLines.map((line) => {
        let spaces = 0;
        while (spaces < indentCount && line[spaces] === " ") {
          spaces++;
        }
        return line.slice(spaces);
      })
    : rawCodeLines;

  return { code: codeLines.join("\n"), info, hadFence: true };
}

export function dedentIndentedCode(raw: string): string {
  if (!raw) return "";
  const lines = normalizeNewlines(raw).split("\n");
  const dedentedLines = lines.map((line) => {
    let cols = 0;
    let i = 0;
    while (i < line.length && cols < 4) {
      const ch = line[i];
      if (ch === " ") {
        cols += 1;
        i += 1;
      } else if (ch === "\t") {
        const nextCol = (cols + 4) - (cols % 4);
        if (nextCol <= 4) {
          cols = nextCol;
          i += 1;
        } else {
          const remainingSpaces = nextCol - 4;
          return " ".repeat(remainingSpaces) + line.slice(i + 1);
        }
      } else {
        break;
      }
    }
    return line.slice(i);
  });
  return dedentedLines.join("\n");
}

function getDomParser(): DOMParser | null {
  if (typeof window !== "undefined" && typeof window.DOMParser === "function") {
    return new window.DOMParser();
  }
  if (typeof DOMParser !== "undefined") {
    try {
      return new DOMParser();
    } catch (e) {
      return null;
    }
  }
  return null;
}

export function extractHighlightedLines(html: string, fallbackLength: number): HighlightedLine[] {
  if (!html) {
    return new Array(Math.max(0, fallbackLength)).fill(null);
  }

  const parser = getDomParser();
  if (parser) {
    try {
      const doc = parser.parseFromString(`<div>${html}</div>`, "text/html");
      const nodes = doc.querySelectorAll("span.line");
      if (nodes.length > 0) {
        const lines: HighlightedLine[] = [];
        for (const node of nodes) {
          lines.push(node instanceof Element ? node.innerHTML : null);
        }
        return normalizeHighlightedLines(lines, fallbackLength);
      }
    } catch (error) {
      // fall through to manual extraction
    }
  }

  return manualExtractHighlightedLines(html, fallbackLength);
}

export function normalizeHighlightedLines(lines: HighlightedLine[], fallbackLength: number): HighlightedLine[] {
  if (!lines || lines.length === 0) {
    return new Array(Math.max(0, fallbackLength)).fill(null);
  }
  const length = Math.max(fallbackLength, lines.length);
  const result: HighlightedLine[] = new Array(length).fill(null);
  for (let i = 0; i < lines.length; i++) {
    result[i] = lines[i];
  }
  return result;
}

function manualExtractHighlightedLines(html: string, fallbackLength: number): HighlightedLine[] {
  const lineRegex = /<span class="line"(?:\s+[^>]*)?>/gi;
  const lines: string[] = [];
  let match: RegExpExecArray | null = lineRegex.exec(html);

  while (match !== null) {
    const openTagEnd = html.indexOf(">", match.index);
    if (openTagEnd === -1) break;
    let cursor = openTagEnd + 1;
    let depth = 1;
    let buffer = "";

    while (cursor < html.length && depth > 0) {
      const nextTagStart = html.indexOf("<", cursor);
      if (nextTagStart === -1) {
        buffer += html.slice(cursor);
        cursor = html.length;
        break;
      }
      if (nextTagStart > cursor) {
        buffer += html.slice(cursor, nextTagStart);
      }
      cursor = nextTagStart;
      if (html.startsWith("</span>", cursor)) {
        depth -= 1;
        cursor += 7;
        if (depth === 0) break;
        buffer += "</span>";
        continue;
      }
      const tagEnd = html.indexOf(">", cursor);
      if (tagEnd === -1) {
        buffer += html.slice(cursor);
        cursor = html.length;
        break;
      }
      const tag = html.slice(cursor, tagEnd + 1);
      if (/^<span\b/i.test(tag)) {
        depth += 1;
      }
      buffer += tag;
      cursor = tagEnd + 1;
    }

    lines.push(buffer);
    lineRegex.lastIndex = cursor;
    match = lineRegex.exec(html);
  }

  return normalizeHighlightedLines(lines, fallbackLength);
}

export function getDefaultCodeWrapperAttributes(
  lang?: string,
  themes?: { dark?: string; light?: string },
): {
  preAttrs: Record<string, string>;
  codeAttrs: Record<string, string>;
} {
  const language = lang && typeof lang === "string" && lang.length > 0 ? lang : "text";
  const darkTheme = themes?.dark ?? "github-dark";
  const lightTheme = themes?.light ?? "github-light";
  const themeLabel = `${darkTheme} ${lightTheme}`;
  return {
    preAttrs: {
      class: `shiki shiki-themes ${themeLabel}`,
      "data-language": language,
      style: "--shiki-dark-bg: transparent; --shiki-light-bg: transparent",
    },
    codeAttrs: {
      "data-language": language,
      "data-theme": themeLabel,
      style: "display: grid;",
    },
  };
}

export function extractCodeLines(raw: string): string[] {
  if (!raw) return [];
  const normalized = normalizeNewlines(raw);
  const { code, hadFence } = stripCodeFence(normalized);
  if (hadFence) {
    return code.split("\n");
  }
  if (/^\s{4}/m.test(normalized)) {
    return dedentIndentedCode(normalized).split("\n");
  }
  return normalized.split("\n");
}

export function extractCodeWrapperAttributes(html: string): {
  preAttrs?: Record<string, string>;
  codeAttrs?: Record<string, string>;
} {
  if (!html) {
    return {};
  }
  const preMatch = html.match(/<pre\b([^>]*)>/i);
  const codeMatch = html.match(/<code\b([^>]*)>/i);
  return {
    preAttrs: preMatch ? filterAllowedAttributes(parseAttributeFragment(preMatch[1] ?? "")) : undefined,
    codeAttrs: codeMatch ? filterAllowedAttributes(parseAttributeFragment(codeMatch[1] ?? "")) : undefined,
  };
}

function parseAttributeFragment(fragment: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null = regex.exec(fragment);
  while (match !== null) {
    const [, name, value] = match;
    attrs[name] = value;
    match = regex.exec(fragment);
  }
  return attrs;
}

function filterAllowedAttributes(attrs: Record<string, string>): Record<string, string> {
  const allowed = new Set(["class", "style", "data-theme"]);
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (allowed.has(key) || key.startsWith("data-")) {
      filtered[key] = value;
    }
  }
  return filtered;
}
