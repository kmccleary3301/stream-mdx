export type HighlightedLine = string | null;

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n?/g, "\n");
}

function isFenceLine(line: string): boolean {
  return /^```/.test(line.trim());
}

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
  if (!isFenceLine(firstLine)) {
    return { code: normalized, info: "", hadFence: false };
  }

  const info = firstLine.slice(3).trim();
  let endIndex = lines.length - 1;
  while (endIndex > 0 && lines[endIndex].trim().length === 0) {
    endIndex--;
  }
  if (endIndex > 0 && isFenceLine(lines[endIndex])) {
    const codeLines = lines.slice(1, endIndex);
    return { code: codeLines.join("\n"), info, hadFence: true };
  }

  // During streaming, code block may not have closing fence yet
  // Still extract and return the info from the opening fence
  const codeLines = lines.slice(1);
  return { code: codeLines.join("\n"), info, hadFence: true };
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
  themes: { dark: string; light: string } = { dark: "github-dark", light: "github-light" },
): {
  preAttrs: Record<string, string>;
  codeAttrs: Record<string, string>;
} {
  const language = lang && typeof lang === "string" && lang.length > 0 ? lang : "text";
  const themeLabel = `${themes.dark} ${themes.light}`;
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

export function dedentIndentedCode(raw: string): string {
  if (!raw) return "";
  const normalized = normalizeNewlines(raw);
  const lines = normalized.split("\n");
  let minIndent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const match = line.match(/^\s+/);
    if (!match) continue;
    minIndent = Math.min(minIndent, match[0].length);
  }
  if (!Number.isFinite(minIndent) || minIndent === 0) {
    return normalized;
  }
  return lines.map((line) => (line.startsWith(" ".repeat(minIndent)) ? line.slice(minIndent) : line)).join("\n");
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
