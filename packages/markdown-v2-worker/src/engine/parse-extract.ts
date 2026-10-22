import type { SyntaxNode } from "@lezer/common";
import { parser as nativeParser, type MarkdownParser } from "@lezer/markdown";
import type {
  Block,
  InlineNode,
  InlineParser,
  MixedContentSegment,
  Patch,
  ProtectedRange,
  TocHeading,
} from "@stream-mdx/core";
import { PATCH_ROOT_ID } from "@stream-mdx/core";
import { parseTableCellInline } from "./table-cell-inline";
import type { ContentChangeRange } from "./types";

/** Withhold only an unfinished matching fence marker from provisional code. */
export function trimProvisionalFenceTail(raw: string): string {
  const normalized = raw.replace(/\r\n?/g, "\n");
  if (normalized.endsWith("\n")) return raw;
  const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(normalized);
  if (!opening) return raw;
  const lastNewline = normalized.lastIndexOf("\n");
  const tail = /^ {0,3}(`+|~+)[\t ]*$/.exec(normalized.slice(lastNewline + 1));
  if (!tail || tail[1][0] !== opening[1][0] || tail[1].length >= opening[1].length) return raw;
  return normalized.slice(0, lastNewline);
}

/** Native CodeText already excludes container marks; retain its opener as marker evidence. */
export function trimProvisionalNativeCode(raw: string, code: string): string {
  const normalizedRaw = raw.replace(/\r\n?/g, "\n");
  if (normalizedRaw.endsWith("\n")) return code;
  const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(normalizedRaw);
  if (!opening) return code;
  const rawTail = /^[ >\t]*(`+|~+)[\t ]*$/.exec(normalizedRaw.slice(normalizedRaw.lastIndexOf("\n") + 1));
  if (!rawTail || rawTail[1][0] !== opening[1][0] || rawTail[1].length >= opening[1].length) return code;
  const normalizedCode = code.replace(/\r\n?/g, "\n");
  const lastNewline = normalizedCode.lastIndexOf("\n");
  const tail = /^ {0,3}(`+|~+)[\t ]*$/.exec(normalizedCode.slice(lastNewline + 1));
  if (!tail || tail[1] !== rawTail[1]) return code;
  return lastNewline < 0 ? "" : normalizedCode.slice(0, lastNewline);
}

/** Match native list-item owners by absolute source range, never by their text. */
export function collectNestedListItemInlineSources(
  block: Block,
  parser: MarkdownParser,
  nativeNode?: SyntaxNode,
  includeSourcePositions = false,
): Map<string, { text: string; from: number; sourcePositions?: number[] }> {
  const source = block.payload.raw;
  const offset = block.payload.range?.from ?? 0;
  const sourceOffset = nativeNode ? offset : 0;
  const sources = new Map<string, { text: string; from: number; sourcePositions?: number[] }>();
  const captureSourcePositions = includeSourcePositions && block.isFinalized;
  const leafText = (node: SyntaxNode): { text: string; sourcePositions?: number[] } => {
    const marks: SyntaxNode[] = [];
    const collectMarks = (child: SyntaxNode): void => {
      if (child.type.name === "QuoteMark") marks.push(child);
      else for (let nested = child.firstChild; nested; nested = nested.nextSibling) collectMarks(nested);
    };
    collectMarks(node);
    let rawText = "";
    const rawPositions = captureSourcePositions ? [] as number[] : undefined;
    const appendRange = (from: number, to: number) => {
      rawText += source.slice(from, to);
      if (rawPositions) for (let position = from; position < to; position++) rawPositions.push(offset + position);
    };
    let from = node.from - sourceOffset;
    for (const mark of marks.sort((a, b) => a.from - b.from)) {
      const markFrom = mark.from - sourceOffset;
      appendRange(from, markFrom);
      from = mark.to - sourceOffset;
      if (source[from] === " " || source[from] === "\t") from++;
    }
    appendRange(from, node.to - sourceOffset);
    if (!rawPositions) return { text: rawText.split("\n").map((line) => line.trimStart()).join("\n") };

    let text = "";
    const sourcePositions: number[] = [];
    let lineStart = 0;
    while (lineStart <= rawText.length) {
      const newline = rawText.indexOf("\n", lineStart);
      const lineEnd = newline === -1 ? rawText.length : newline;
      const line = rawText.slice(lineStart, lineEnd);
      const trimLength = line.length - line.trimStart().length;
      text += line.slice(trimLength);
      for (let index = lineStart + trimLength; index < lineEnd; index++) sourcePositions.push(rawPositions[index]);
      if (newline === -1) break;
      text += "\n";
      sourcePositions.push(rawPositions[newline]);
      lineStart = newline + 1;
    }
    return { text, sourcePositions };
  };
  const visit = (node: SyntaxNode): void => {
    if (node.type.name === "ListItem" || node.type.name === "EmptyListItem") {
      let primary = node.firstChild;
      while (primary && ["ListMark", "QuoteMark", "LinkReference"].includes(primary.type.name)) primary = primary.nextSibling;
      const leaf = primary && (primary.type.name === "Paragraph" || primary.type.name === "Task")
        ? leafText(primary)
        : { text: "" };
      const task = primary?.type.name === "Task" ? /^\[([ xX])\][ \t]+/.exec(leaf.text) : null;
      const text = task ? leaf.text.slice(task[0].length) : leaf.text;
      const sourcePositions = leaf.sourcePositions?.slice(task?.[0].length ?? 0);
      sources.set(`${offset + node.from - sourceOffset}:${offset + node.to - sourceOffset}`, {
        text,
        from: sourcePositions?.[0] ?? (offset + (primary?.from ?? node.from) - sourceOffset + (task?.[0].length ?? 0)),
        ...(sourcePositions ? { sourcePositions } : {}),
      });
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
  };
  visit(nativeNode ?? parser.parse(source).topNode);
  return sources;
}
/** Return an exact authored heading-content span using native marker coordinates. */
export function getNativeHeadingContentRange(
  node: SyntaxNode,
  rawSource: string,
  baseOffset: number,
): { from: number; to: number } | undefined {
  if (!Number.isSafeInteger(baseOffset) || baseOffset < 0) return undefined;
  const localNodeFrom = node.from - baseOffset;
  const localNodeTo = node.to - baseOffset;
  if (localNodeFrom < 0 || localNodeTo <= localNodeFrom || localNodeTo > rawSource.length) return undefined;

  const headerMarks: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.type.name === "HeaderMark") headerMarks.push(child);
  }
  let start: number;
  let end: number;
  if (node.type.name.startsWith("ATXHeading")) {
    const opening = headerMarks[0];
    if (!opening) return undefined;
    start = opening.to - baseOffset;
    if (start < localNodeFrom || start > localNodeTo) return undefined;
    while (start < localNodeTo && (rawSource[start] === " " || rawSource[start] === "\t")) start++;
    const closing = headerMarks.length > 1 ? headerMarks[headerMarks.length - 1] : undefined;
    end = closing ? closing.from - baseOffset : localNodeTo;
  } else if (node.type.name.startsWith("SetextHeading")) {
    const underline = headerMarks[headerMarks.length - 1];
    if (!underline) return undefined;
    start = localNodeFrom;
    end = underline.from - baseOffset;
    while (start < end && (rawSource[start] === " " || rawSource[start] === "\t")) start++;
  } else {
    return undefined;
  }

  if (end < start || end > localNodeTo) return undefined;
  while (end > start) {
    const character = rawSource[end - 1];
    if (character !== " " && character !== "\t" && character !== "\r" && character !== "\n") break;
    end--;
  }
  return end > start
    ? { from: baseOffset + start, to: baseOffset + end }
    : undefined;
}




export function slugifyHeading(text: string): string {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized;
}

export function buildTocHeadings(blocksInput: Block[]): TocHeading[] {
  const headings: TocHeading[] = [];

  for (const block of blocksInput) {
    if (block.type !== "heading") continue;
    const meta = (block.payload.meta ?? {}) as Record<string, unknown>;
    const levelRaw = typeof meta.headingLevel === "number" ? meta.headingLevel : 1;
    const level = Math.min(Math.max(levelRaw, 1), 6);
    const id = typeof meta.headingId === "string" ? meta.headingId : slugifyHeading(String(block.payload.raw ?? ""));
    const text = typeof meta.headingText === "string" ? meta.headingText : String(block.payload.raw ?? "");
    headings.push({
      id: id || "heading",
      blockId: block.id,
      level,
      text: text.trim(),
    });
  }

  return headings;
}

export function tocSignatureFor(headings: TocHeading[]): string {
  if (headings.length === 0) return "";
  return headings.map((heading) => `${heading.blockId}:${heading.id}:${heading.level}:${heading.text}`).join("|");
}

export function maybeBuildTocPatch(
  blocksInput: Block[],
  currentSignature: string,
): { patch: Patch | null; nextHeadings: TocHeading[]; nextSignature: string } {
  const nextHeadings = buildTocHeadings(blocksInput);
  const nextSignature = tocSignatureFor(nextHeadings);
  if (nextSignature === currentSignature) {
    return { patch: null, nextHeadings, nextSignature: currentSignature };
  }
  const patch: Patch = {
    op: "setProps",
    at: { blockId: PATCH_ROOT_ID },
    props: {
      tocHeadings: nextHeadings,
    },
  };
  return { patch, nextHeadings, nextSignature };
}

/** Native code-span grammar owns braces, tags and dollars inside matching delimiters. */
export function collectCodeProtectedRanges(content: string): ProtectedRange[] {
  if (!content.includes("`")) return [];
  const ranges: ProtectedRange[] = [];
  const cursor = nativeParser.parse(content).cursor();
  do {
    if (cursor.name === "InlineCode") ranges.push({ from: cursor.from, to: cursor.to, kind: "code-inline" });
  } while (cursor.next());
  return ranges;
}

export function collectMathProtectedRanges(content: string, codeRanges?: ReadonlyArray<ProtectedRange>): ProtectedRange[] {
  if (!content) return [];
  const ranges: ProtectedRange[] = [];
  const inlineStack: number[] = [];
  const displayStack: number[] = [];
  const length = content.length;
  codeRanges ??= content.includes("$") ? collectCodeProtectedRanges(content) : [];
  let codeIndex = 0;

  let i = 0;
  while (i < length) {
    const char = content[i];
    while (codeIndex < codeRanges.length && codeRanges[codeIndex].to <= i) codeIndex++;
    const codeRange = codeRanges[codeIndex];
    if (inlineStack.length === 0 && displayStack.length === 0 && codeRange && codeRange.from <= i) {
      i = codeRange.to;
      continue;
    }
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === "\n" || char === "\r") {
      inlineStack.length = 0;
      i += 1;
      continue;
    }
    if (char !== "$") {
      i++;
      continue;
    }

    const isDouble = i + 1 < length && content[i + 1] === "$";
    if (isDouble) {
      if (displayStack.length > 0) {
        const start = displayStack.pop() as number;
        ranges.push({ from: start, to: i + 2, kind: "math-display" });
      } else {
        displayStack.push(i);
      }
      i += 2;
      continue;
    }

    if (inlineStack.length > 0) {
      const start = inlineStack.pop() as number;
      ranges.push({ from: start, to: i + 1, kind: "math-inline" });
    } else {
      inlineStack.push(i);
    }
    i++;
  }

  // An unmatched display opener still owns its local source. Raw lookahead fallback
  // must not expose TeX braces/tags to MDX compilation, which closes math at EOF.
  for (const start of displayStack) {
    ranges.push({ from: start, to: length, kind: "math-display" });
  }

  return ranges;
}

export function collectAutolinkProtectedRanges(content: string): ProtectedRange[] {
  if (!content) return [];
  const ranges: ProtectedRange[] = [];
  const autolinkPattern = /<((?:https?:\/\/|mailto:)[^>\s]+)>/gi;
  let match: RegExpExecArray | null;
  while (true) {
    match = autolinkPattern.exec(content);
    if (match === null) break;
    ranges.push({ from: match.index, to: match.index + match[0].length, kind: "autolink" });
  }
  return ranges;
}

export function collectHtmlProtectedRangesFromSegments(
  segments: MixedContentSegment[],
  baseOffset: number | undefined,
): ProtectedRange[] {
  if (!segments || segments.length === 0) return [];
  if (typeof baseOffset !== "number" || !Number.isFinite(baseOffset)) {
    return [];
  }
  const ranges: ProtectedRange[] = [];
  for (const segment of segments) {
    if (segment.kind === "html" && segment.range) {
      ranges.push({
        from: segment.range.from - baseOffset,
        to: segment.range.to - baseOffset,
        kind: "html-block",
      });
    }
  }
  return ranges;
}



export function collectWorkerStructuralInvariantViolations(nextBlocks: ReadonlyArray<Block>): string[] {
  const violations: string[] = [];

  for (const block of nextBlocks) {
    if (block.type === "table" && block.isFinalized) {
      const tableMeta = (block.payload.meta ?? {}) as { header?: unknown[]; rows?: unknown[][] };
      const headerColumns = Array.isArray(tableMeta.header) ? tableMeta.header.length : 0;
      const rows = Array.isArray(tableMeta.rows) ? tableMeta.rows : [];
      if (headerColumns > 0) {
        rows.forEach((row, rowIndex) => {
          if (row.length !== headerColumns) {
            violations.push(`finalized table row width mismatch:${block.id}:${rowIndex}:${row.length}:${headerColumns}`);
          }
        });
      }
    }


  }
  return violations;
}

export function reportWorkerStructuralInvariantViolations(
  context: string,
  nextBlocks: ReadonlyArray<Block>,
  lastSignature: { value: string },
): void {
  const violations = collectWorkerStructuralInvariantViolations(nextBlocks);
  if (violations.length === 0) {
    lastSignature.value = "";
    return;
  }
  const signature = violations.join(" || ");
  if (signature === lastSignature.value) {
    return;
  }
  lastSignature.value = signature;
  console.error(`[stream-mdx:worker] Structural invariant violation in ${context}:\n${violations.map((v) => `  - ${v}`).join("\n")}`);
}

export function rangesIntersect(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return Math.max(aFrom, bFrom) <= Math.min(aTo, bTo);
}

export function addIntersectingBlocks(target: Set<string>, blocks: Block[], from: number, to: number): void {
  if (from === to) {
    for (const block of blocks) {
      const range = block.payload.range;
      if (!range) continue;
      const blockFrom = typeof range.from === "number" ? range.from : 0;
      const blockTo = typeof range.to === "number" ? range.to : blockFrom;
      if (from >= blockFrom && from <= blockTo) {
        target.add(block.id);
      }
    }
    return;
  }
  for (const block of blocks) {
    const range = block.payload.range;
    if (!range) continue;
    const blockFrom = typeof range.from === "number" ? range.from : 0;
    const blockTo = typeof range.to === "number" ? range.to : blockFrom;
    if (rangesIntersect(from, to, blockFrom, blockTo)) {
      target.add(block.id);
    }
  }
}

export function collectChangedBlockIds(previousBlocks: Block[], nextBlocks: Block[], ranges: ContentChangeRange[]): Set<string> {
  const ids = new Set<string>();
  if (!ranges || ranges.length === 0) {
    return ids;
  }
  for (const range of ranges) {
    addIntersectingBlocks(ids, previousBlocks, range.fromA, range.toA);
    addIntersectingBlocks(ids, nextBlocks, range.fromB, range.toB);
  }
  return ids;
}

export function parseGfmTableFromTree(
  raw: string,
  inlineParser: InlineParser,
  baseOffset?: number,
): {
  header: InlineNode[][];
  align: ("left" | "center" | "right" | null)[];
  rows: InlineNode[][][];
  headerCellSources?: string[];
  rowCellSources?: string[][];
  headerCellRanges?: Array<{ from: number; to: number } | undefined>;
  rowCellRanges?: Array<Array<{ from: number; to: number } | undefined>>;
} | null {
  const lines: Array<{ value: string; from: number }> = [];
  let lineFrom = 0;
  for (const value of raw.split("\n")) {
    if (value.trim().length > 0) lines.push({ value, from: lineFrom });
    lineFrom += value.length + 1;
  }
  if (lines.length < 2) return null;
  const headerLine = lines[0];
  const delimLine = lines[1];
  const bodyLines = lines.slice(2);
  const hasSourceOffset = Number.isSafeInteger(baseOffset) && (baseOffset as number) >= 0;

  const splitCells = (line: { value: string; from: number }): Array<{ value: string; range?: { from: number; to: number } }> => {
    let trimmed = line.value.trim();
    let sourceFrom = line.from + line.value.length - line.value.trimStart().length;
    if (trimmed.startsWith("|")) {
      trimmed = trimmed.slice(1);
      sourceFrom++;
    }
    if (trimmed.endsWith("|")) {
      let count = 0;
      let j = trimmed.length - 2;
      while (j >= 0 && trimmed[j] === "\\") {
        count++;
        j--;
      }
      if (count % 2 === 0) {
        trimmed = trimmed.slice(0, -1);
      }
    }

    const cells: Array<{ value: string; range?: { from: number; to: number } }> = [];
    let cellStart = 0;
    let inCode = false;
    const pushCell = (end: number) => {
      const rawCell = trimmed.slice(cellStart, end);
      const value = rawCell.trim();
      const localFrom = sourceFrom + cellStart + rawCell.length - rawCell.trimStart().length;
      cells.push({
        value,
        ...(hasSourceOffset && value.length > 0
          ? { range: { from: (baseOffset as number) + localFrom, to: (baseOffset as number) + localFrom + value.length } }
          : {}),
      });
    };
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === "`") {
        inCode = !inCode;
      } else if (ch === "\\" && i + 1 < trimmed.length) {
        i++;
      } else if (ch === "|" && !inCode) {
        pushCell(i);
        cellStart = i + 1;
      }
    }
    pushCell(trimmed.length);
    return cells;
  };

  const headerCells = splitCells(headerLine);
  const delimCells = splitCells(delimLine);
  if (headerCells.length === 0 || delimCells.length === 0) return null;

  const align: ("left" | "center" | "right" | null)[] = delimCells.map((cell) => {
    const left = cell.value.startsWith(":");
    const right = cell.value.endsWith(":");
    if (left && right) return "center";
    if (left) return "left";
    if (right) return "right";
    return null;
  });

  const parseCell = (cell: (typeof headerCells)[number]): InlineNode[] => {
    const sourceOffset = cell.range?.from;
    return parseTableCellInline(inlineParser, cell.value, sourceOffset === undefined ? {} : { sourceOffset });
  };
  const header = headerCells.map(parseCell);
  const colCount = header.length;
  const parsedRows = bodyLines.map((line) => {
    const cells = splitCells(line);
    while (cells.length < colCount) cells.push({ value: "" });
    return cells.slice(0, colCount);
  });
  const rows = parsedRows.map((cells) => cells.map(parseCell));
  const headerCellRanges = hasSourceOffset ? headerCells.map((cell) => cell.range) : undefined;
  const rowCellRanges = hasSourceOffset ? parsedRows.map((row) => row.map((cell) => cell.range)) : undefined;

  return {
    header,
    align: align.slice(0, colCount),
    rows,
    ...(hasSourceOffset ? {
      headerCellSources: headerCells.slice(0, colCount).map((cell) => cell.value),
      rowCellSources: parsedRows.map((row) => row.slice(0, colCount).map((cell) => cell.value)),
    } : {}),
    ...(headerCellRanges ? { headerCellRanges } : {}),
    ...(rowCellRanges ? { rowCellRanges } : {}),
  };
}
