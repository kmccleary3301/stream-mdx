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
export function collectNestedListItemInlineSources(block: Block, parser: MarkdownParser, nativeNode?: SyntaxNode): Map<string, string> {
  const source = block.payload.raw;
  const offset = block.payload.range?.from ?? 0;
  const sourceOffset = nativeNode ? offset : 0;
  const sources = new Map<string, string>();
  const leafText = (node: SyntaxNode): string => {
    const marks: SyntaxNode[] = [];
    const collectMarks = (child: SyntaxNode): void => {
      if (child.type.name === "QuoteMark") marks.push(child);
      else for (let nested = child.firstChild; nested; nested = nested.nextSibling) collectMarks(nested);
    };
    collectMarks(node);
    let text = "";
    let from = node.from - sourceOffset;
    for (const mark of marks.sort((a, b) => a.from - b.from)) {
      text += source.slice(from, mark.from - sourceOffset);
      from = mark.to - sourceOffset;
      if (source[from] === " " || source[from] === "\t") from++;
    }
    return (text + source.slice(from, node.to - sourceOffset)).split("\n").map((line) => line.trimStart()).join("\n");
  };
  const visit = (node: SyntaxNode): void => {
    if (node.type.name === "ListItem" || node.type.name === "EmptyListItem") {
      let primary = node.firstChild;
      while (primary && ["ListMark", "QuoteMark", "LinkReference"].includes(primary.type.name)) primary = primary.nextSibling;
      let text = primary && (primary.type.name === "Paragraph" || primary.type.name === "Task") ? leafText(primary) : "";
      if (primary?.type.name === "Task") text = text.replace(/^\[([ xX])\][ \t]+/, "");
      sources.set(`${offset + node.from - sourceOffset}:${offset + node.to - sourceOffset}`, text);
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
  };
  visit(nativeNode ?? parser.parse(source).topNode);
  return sources;
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

export function collectMathProtectedRanges(content: string): ProtectedRange[] {
  if (!content) return [];
  const ranges: ProtectedRange[] = [];
  const inlineStack: number[] = [];
  const displayStack: number[] = [];
  const length = content.length;
  const codeRanges: Array<{ from: number; to: number }> = [];
  if (content.includes("`") && content.includes("$")) {
    const cursor = nativeParser.parse(content).cursor();
    do {
      if (cursor.name === "InlineCode") codeRanges.push({ from: cursor.from, to: cursor.to });
    } while (cursor.next());
  }
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

    if (block.type !== "mdx") {
      if (block.payload.compiledMdxRef || block.payload.compiledMdxModule) {
        violations.push(`non-mdx block carries mdx artifact:${block.id}:${block.type}`);
      }
      continue;
    }

    const meta = (block.payload.meta ?? {}) as { mdxStatus?: unknown };
    const status = typeof meta.mdxStatus === "string" ? meta.mdxStatus : undefined;
    const hasCompiledArtifact = Boolean(block.payload.compiledMdxRef || block.payload.compiledMdxModule);

    if (block.isFinalized && status === "pending") {
      violations.push(`finalized mdx block remained pending:${block.id}`);
    }
    if (status === "compiled" && !hasCompiledArtifact) {
      violations.push(`compiled mdx block missing artifact:${block.id}`);
    }
    if (status === "error" && hasCompiledArtifact) {
      violations.push(`errored mdx block retained compiled artifact:${block.id}`);
    }
    if (
      block.payload.compiledMdxRef &&
      block.payload.compiledMdxModule &&
      block.payload.compiledMdxRef.id !== block.payload.compiledMdxModule.id
    ) {
      violations.push(`mdx artifact id mismatch:${block.id}:${block.payload.compiledMdxRef.id}:${block.payload.compiledMdxModule.id}`);
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
): { header: InlineNode[][]; align: ("left" | "center" | "right" | null)[]; rows: InlineNode[][][] } | null {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;
  const headerLine = lines[0];
  const delimLine = lines[1];
  const bodyLines = lines.slice(2);

  const splitCells = (line: string): string[] => {
    let trimmed = line.trim();
    if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
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
    const cells: string[] = [];
    let cur = "";
    let inCode = false;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === "`") {
        inCode = !inCode;
        cur += ch;
      } else if (ch === "\\" && i + 1 < trimmed.length) {
        cur += ch + trimmed[i + 1];
        i++;
      } else if (ch === "|" && !inCode) {
        cells.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    return cells;
  };

  const headerCells = splitCells(headerLine);
  const delimCells = splitCells(delimLine);
  if (headerCells.length === 0 || delimCells.length === 0) return null;

  const align: ("left" | "center" | "right" | null)[] = delimCells.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (left) return "left";
    if (right) return "right";
    return null;
  });

  const header = headerCells.map((c) => inlineParser.parse(c.replace(/\\\|/g, "|")));
  const colCount = header.length;

  const rows: InlineNode[][][] = bodyLines.map((line) => {
    const rowCells = splitCells(line);
    while (rowCells.length < colCount) {
      rowCells.push("");
    }
    return rowCells.slice(0, colCount).map((c) => inlineParser.parse(c.replace(/\\\|/g, "|")));
  });

  return { header, align: align.slice(0, colCount), rows };
}
