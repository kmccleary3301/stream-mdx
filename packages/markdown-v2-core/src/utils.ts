// Utility functions for V2 Markdown Renderer

import { type Block, LANGUAGE_ALIASES, type ProtectedRange } from "./types";

// Browser-compatible crypto import
const createHash = (_algorithm: string) => {
  let hash = 0;
  return {
    update(data: string) {
      for (let i = 0; i < data.length; i++) {
        hash = ((hash << 5) - hash + data.charCodeAt(i)) & 0xffffffff;
      }
      return this;
    },
    digest(_encoding: string) {
      return Math.abs(hash).toString(16);
    },
  };
};

/**
 * Generate stable content hash for blocks
 */
export function generateBlockId(content: string, type: string): string {
  const hash = createHash("sha256");
  hash.update(`${type}:${content}`);
  return hash.digest("hex").slice(0, 16);
}

/**
 * Normalize language names for syntax highlighting
 */
export function normalizeLang(raw?: string): string {
  const k = (raw || "").trim().toLowerCase();
  return LANGUAGE_ALIASES[k] ?? (k || "text");
}

/**
 * Apply tail splice (immutability & guards)
 */
export function applyUpdate(blocks: Block[], update: { start: number; tail: Block[] }): Block[] {
  // Guards
  if (update.start < 0 || update.start > blocks.length) return blocks;

  // Ensure finalized invariants
  for (let i = 0; i < update.start; i++) {
    if (!blocks[i].isFinalized) {
      throw new Error("Invariant violated: non-finalized before start");
    }
  }

  // Splice tail immutably
  const next = blocks.slice(0, update.start).concat(update.tail);

  // Ensure only last is dirty (if any)
  for (let i = 0; i < next.length - 1; i++) {
    if (!next[i].isFinalized) throw new Error("Only tail may be dirty");
  }

  return next;
}

/**
 * Generate stable React keys for blocks
 */
export function getBlockKey(block: Block): string {
  return `${block.id}:${block.isFinalized ? 1 : 0}`;
}

/**
 * Check if content contains MDX-like syntax
 */
export function detectMDX(content: string, options?: { protectedRanges?: ReadonlyArray<ProtectedRange>; baseOffset?: number }): boolean {
  const inlineCodeRanges = collectInlineCodeRanges(content);

  // Basic heuristic for MDX detection
  const componentPattern = /<([A-Z][\w-]*)(\s|\/?>)/g;
  let componentMatch: RegExpExecArray | null = componentPattern.exec(content);
  while (componentMatch !== null) {
    const start = componentMatch.index;
    const end = start + componentMatch[0].length;
    if (!isWithinRanges(start, end, inlineCodeRanges)) {
      return true;
    }
    componentMatch = componentPattern.exec(content);
  }

  // Detect import/export statements (MDX/ESM)
  if (/(^|\n)\s*(import|export)\s/.test(content)) {
    return true;
  }

  // Detect inline JSX expressions while ignoring TeX/LaTeX braces (`\command{}`)
  const expressionPattern = /\{[^{}]+\}/g;
  const protectedRanges = options?.protectedRanges ?? [];
  const baseOffset = typeof options?.baseOffset === "number" ? options.baseOffset : 0;
  const protectedKinds = protectedRanges.length ? new Set<ProtectedRange["kind"]>(["math-inline", "math-display", "code-inline", "code-block"]) : null;

  for (let match = expressionPattern.exec(content); match !== null; match = expressionPattern.exec(content)) {
    const index = match.index;
    const prev = index > 0 ? content[index - 1] : "";
    if (prev === "\\" || prev === "$" || prev === "^" || prev === "_") {
      continue;
    }
    const prefix = content.slice(Math.max(0, index - 8), index);
    if (/\\[a-zA-Z]+$/.test(prefix.trimEnd())) {
      continue;
    }
    const inner = match[0].slice(1, -1).trimStart();
    if (/^[\s0-9+\-*/(),.=\\^_]+$/.test(inner)) {
      continue;
    }
    if (inner.startsWith("\\") || inner.startsWith("^") || inner.startsWith("_") || inner.startsWith("$")) {
      continue;
    }
    const exprStart = index;
    const exprEnd = exprStart + match[0].length;
    if (isWithinRanges(exprStart, exprEnd, inlineCodeRanges)) {
      continue;
    }
    if (protectedKinds) {
      const absoluteStart = baseOffset + index;
      const absoluteEnd = absoluteStart + match[0].length;
      const covered = protectedRanges.some((range) => protectedKinds.has(range.kind) && range.from <= absoluteStart && range.to >= absoluteEnd);
      if (covered) {
        continue;
      }
    }
    return true;
  }

  return false;
}

function collectInlineCodeRanges(content: string): Array<{ from: number; to: number }> {
  if (!content) return [];
  const ranges: Array<{ from: number; to: number }> = [];
  const codeSpanRegex = /`(?:\\`|[^`])*?`/g;
  let codeMatch: RegExpExecArray | null = codeSpanRegex.exec(content);
  while (codeMatch !== null) {
    ranges.push({ from: codeMatch.index, to: codeMatch.index + codeMatch[0].length });
    codeMatch = codeSpanRegex.exec(content);
  }
  return ranges;
}

function isWithinRanges(start: number, end: number, ranges: Array<{ from: number; to: number }>): boolean {
  return ranges.some((range) => range.from <= start && range.to >= end);
}

/**
 * Parse code fence info (language and metadata)
 */
export function parseCodeFenceInfo(info: string): { lang: string; meta: Record<string, unknown> } {
  const parts = info.trim().split(/\s+/);
  const lang = normalizeLang(parts[0]);

  const meta: Record<string, unknown> = {};
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (part.includes("=")) {
      const [key, value] = part.split("=", 2);
      meta[key] = value;
    } else {
      meta[part] = true;
    }
  }

  return { lang, meta };
}

/**
 * Normalize blockquote text by removing a single leading ">" (and optional whitespace) per line
 * while preserving internal blank lines that represent separate paragraphs.
 */
export function normalizeBlockquoteText(raw: string): string {
  if (!raw) return "";
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const normalized = lines.map((line) => line.replace(/^\s*>?\s?/, ""));
  // Trim leading/trailing empty lines but preserve internal spacing
  while (normalized.length > 0 && normalized[0].trim().length === 0) {
    normalized.shift();
  }
  while (normalized.length > 0 && normalized[normalized.length - 1].trim().length === 0) {
    normalized.pop();
  }
  return normalized.join("\n");
}

/**
 * Debounce function for performance optimization
 */
export function debounce<T extends (...args: unknown[]) => unknown>(func: T, delay: number): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout;

  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func(...args), delay);
  };
}

/**
 * Performance measurement utility
 */
export class PerformanceTimer {
  private marks: Map<string, number> = new Map();

  mark(name: string): void {
    this.marks.set(name, performance.now());
  }

  measure(name: string): number | null {
    const start = this.marks.get(name);
    if (start === undefined) return null;
    return performance.now() - start;
  }

  reset(): void {
    this.marks.clear();
  }
}

/**
 * Memory-efficient string manipulation
 */
export function removeHeadingMarkers(input: string): string {
  return input
    .replace(/^(#{1,6})\s+/, "")
    .replace(/\s+={2,}\s*$|\s+-{2,}\s*$/m, "")
    .trim();
}

export class StringBuffer {
  private chunks: string[] = [];
  private length = 0;

  append(str: string): void {
    this.chunks.push(str);
    this.length += str.length;
  }

  toString(): string {
    const result = this.chunks.join("");
    this.chunks = [result]; // Consolidate for future operations
    return result;
  }

  getLength(): number {
    return this.length;
  }

  clear(): void {
    this.chunks = [];
    this.length = 0;
  }
}
