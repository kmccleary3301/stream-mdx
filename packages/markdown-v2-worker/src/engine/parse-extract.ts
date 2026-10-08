import type {
  Block,
  MixedContentSegment,
  Patch,
  ProtectedRange,
  TocHeading,
} from "@stream-mdx/core";
import { PATCH_ROOT_ID } from "@stream-mdx/core";
import type { ContentChangeRange } from "./types";

export function slugifyHeading(text: string): string {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return normalized.replace(/^-+|-+$/g, "");
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
      level,
      text: text.trim(),
    });
  }

  return headings;
}

export function tocSignatureFor(headings: TocHeading[]): string {
  if (headings.length === 0) return "";
  return headings.map((heading) => `${heading.id}:${heading.level}:${heading.text}`).join("|");
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
  let displayStart: number | null = null;
  let inCodeSpan = false;
  let codeDelimiterLength = 0;

  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === "`") {
      let run = 1;
      while (i + 1 < content.length && content[i + 1] === "`") {
        run += 1;
        i += 1;
      }
      if (!inCodeSpan) {
        inCodeSpan = true;
        codeDelimiterLength = run;
      } else if (run === codeDelimiterLength) {
        inCodeSpan = false;
        codeDelimiterLength = 0;
      }
      continue;
    }
    if (inCodeSpan) continue;

    if (ch === "$" && (i === 0 || content[i - 1] !== "\\")) {
      const isDouble = i + 1 < content.length && content[i + 1] === "$";
      if (isDouble) {
        i += 1;
        if (displayStart === null) {
          displayStart = i - 1;
        } else {
          ranges.push({ from: displayStart, to: i + 1, kind: "math-display" });
          displayStart = null;
        }
      } else if (displayStart === null) {
        if (inlineStack.length > 0) {
          const from = inlineStack.pop();
          if (typeof from === "number") {
            ranges.push({ from, to: i + 1, kind: "math-inline" });
          }
        } else {
          inlineStack.push(i);
        }
      }
    }
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

export function enrichListBlock(block: Block): void {
  const lines = (block.payload.raw ?? "").split("\n");
  const itemsRaw: string[] = [];
  let current: string[] | null = null;
  let ordered = false;
  let orderedDetected = false;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const unorderedMatch = trimmed.match(/^[-*+]\s+/);
    const orderedMatch = trimmed.match(/^(\d+)\.\s+/);

    if (unorderedMatch || orderedMatch) {
      if (!orderedDetected) {
        ordered = Boolean(orderedMatch);
        orderedDetected = true;
      }
      if (current) {
        itemsRaw.push(current.join("\n"));
      }
      current = [line];
    } else if (current) {
      current.push(line);
    } else if (trimmed) {
      current = [line];
    }
  }

  if (current) {
    itemsRaw.push(current.join("\n"));
  }

  const existingMeta = (block.payload.meta ?? {}) as Record<string, unknown>;
  const listItemsMeta = existingMeta.items && typeof existingMeta.items === "object" ? existingMeta.items : undefined;
  block.payload.meta = {
    ...existingMeta,
    ordered,
    itemsRaw,
    ...(listItemsMeta ? { items: listItemsMeta } : {}),
  };
}

export function collectWorkerStructuralInvariantViolations(nextBlocks: ReadonlyArray<Block>): string[] {
  const violations: string[] = [];

  for (const block of nextBlocks) {
    const raw = typeof block.payload?.raw === "string" ? block.payload.raw : "";
    if (block.type === "code") {
      const match = raw.match(/^[ \t]*(`{3,}|~{3,})([^\n]*)/);
      if (match) {
        const info = (match[2] ?? "").trim();
        const expectedLang = (info.split(/\s+/)[0] ?? "").toLowerCase();
        const actualLang = typeof block.payload.meta?.lang === "string" ? block.payload.meta.lang.toLowerCase() : "";
        if (expectedLang && actualLang && expectedLang !== actualLang && expectedLang !== "diff" && actualLang !== "diff") {
          violations.push(
            `Block ${block.id}: parsed fence language '${expectedLang}' diverges from meta.lang '${actualLang}'.`,
          );
        }
      }
    }

    if (block.type === "heading") {
      const match = raw.match(/^[ \t]*(#{1,6})\s+(.+)$/);
      if (match) {
        const expectedLevel = match[1].length;
        const actualLevel = typeof block.payload.meta?.headingLevel === "number" ? block.payload.meta.headingLevel : 0;
        if (actualLevel && actualLevel !== expectedLevel) {
          violations.push(
            `Block ${block.id}: parsed heading level ${expectedLevel} diverges from meta.headingLevel ${actualLevel}.`,
          );
        }
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

export function computeChangedRanges(previous: string, next: string): ContentChangeRange[] {
  if (previous === next) {
    return [];
  }
  let prefix = 0;
  const maxPrefix = Math.min(previous.length, next.length);
  while (prefix < maxPrefix && previous[prefix] === next[prefix]) {
    prefix += 1;
  }
  let prevSuffix = previous.length - 1;
  let nextSuffix = next.length - 1;
  while (prevSuffix >= prefix && nextSuffix >= prefix && previous[prevSuffix] === next[nextSuffix]) {
    prevSuffix -= 1;
    nextSuffix -= 1;
  }
  return [
    {
      fromA: prefix,
      toA: prevSuffix + 1,
      fromB: prefix,
      toB: nextSuffix + 1,
    },
  ];
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
