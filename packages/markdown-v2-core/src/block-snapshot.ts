import { parser as mdParser } from "@lezer/markdown";
import {
  extractCodeLines,
  extractCodeWrapperAttributes,
  extractHighlightedLines,
  getDefaultCodeWrapperAttributes,
  normalizeHighlightedLines,
  stripCodeFence,
  type HighlightedLine,
} from "./code-highlighting";
import { InlineParser } from "./inline-parser";
import { normalizeFormatAnticipation, prepareInlineStreamingContent } from "./streaming/inline-streaming";
import type { FormatAnticipationConfig } from "./types";
import { extractMixedContentSegments } from "./mixed-content";
import type {
  Block,
  InlineNode,
  MixedContentSegment,
  NodeSnapshot,
  NodePath,
  Patch,
  SetPropsBatchEntry,
} from "./types";
import { PATCH_ROOT_ID } from "./types";
import { normalizeBlockquoteText, parseCodeFenceInfo } from "./utils";

export function cloneBlock(block: Block): Block {
  return {
    ...block,
    payload: {
      ...block.payload,
      inline: block.payload.inline ? cloneInlineNodes(block.payload.inline) : undefined,
      highlightedHtml: block.payload.highlightedHtml,
      sanitizedHtml: block.payload.sanitizedHtml,
      compiledMdxRef: block.payload.compiledMdxRef ? { ...block.payload.compiledMdxRef } : undefined,
      compiledMdxModule: block.payload.compiledMdxModule
        ? {
            ...block.payload.compiledMdxModule,
            dependencies: Array.isArray(block.payload.compiledMdxModule.dependencies) ? [...block.payload.compiledMdxModule.dependencies] : undefined,
          }
        : block.payload.compiledMdxModule === null
          ? null
          : undefined,
      meta: block.payload.meta ? structuredCloneIfPossible(block.payload.meta) : undefined,
      range: block.payload.range ? { ...block.payload.range } : undefined,
    },
  };
}

export function blocksStructurallyEqual(a: Block, b: Block): boolean {
  if (a.type !== b.type) return false;
  if (a.isFinalized !== b.isFinalized) return false;
  if (a.payload.raw !== b.payload.raw) return false;
  const metaA = a.payload.meta ?? null;
  const metaB = b.payload.meta ?? null;
  if (!deepEqual(metaA, metaB)) return false;
  return true;
}

export function createBlockSnapshot(block: Block): NodeSnapshot {
  const base: NodeSnapshot = {
    id: block.id,
    type: block.type,
    props: {
      block: cloneBlock(block),
    },
    meta: block.payload.meta ? structuredCloneIfPossible(block.payload.meta) : undefined,
    range: block.payload.range ? { ...block.payload.range } : undefined,
    children: [],
  };

  switch (block.type) {
    case "paragraph":
      return enrichParagraphSnapshot(block, base);
    case "blockquote":
      return enrichBlockquoteSnapshot(block, base);
    case "list":
      return enrichListSnapshot(block, base);
    case "table":
      return enrichTableSnapshot(block, base);
    case "code":
      return enrichCodeSnapshot(block, base);
    default:
      return base;
  }
}

const listInlineParser = new InlineParser();

function enrichListSnapshot(block: Block, snapshot: NodeSnapshot): NodeSnapshot {
  const raw = block.payload.raw ?? "";
  const baseOffset = block.payload.range?.from ?? 0;
  const listTree = mdParser.parse(raw);
  const listNode = findListNode(listTree.topNode);
  if (!listNode) {
    return fallbackListSnapshot(block, snapshot);
  }

  const ordered = listNode.type.name === "OrderedList" || Boolean((block.payload.meta as { ordered?: boolean } | undefined)?.ordered);
  snapshot.props = { ...(snapshot.props ?? {}), ordered, items: undefined };
  snapshot.children = buildListItemSnapshots(block, listNode, ordered, block.id, baseOffset, raw);
  return snapshot;
}

function findListNode(node: any | null | undefined): any | null {
  if (!node) return null;
  const name = node.type.name;
  if (name === "BulletList" || name === "OrderedList") {
    return node;
  }
  const cursor = node.cursor();
  if (cursor.firstChild()) {
    do {
      const childName = cursor.type.name;
      if (childName === "BulletList" || childName === "OrderedList") {
        return cursor.node;
      }
    } while (cursor.nextSibling());
  }
  return null;
}

function buildListItemSnapshots(block: Block, listNode: any, ordered: boolean, idPrefix: string, baseOffset: number, raw: string): NodeSnapshot[] {
  const items: NodeSnapshot[] = [];
  const cursor = listNode.cursor();
  let index = 0;
  if (cursor.firstChild()) {
    do {
      if (cursor.type.name === "ListItem") {
        const itemId = `${idPrefix}::item:${index}`;
        items.push(buildListItemSnapshot(block, cursor.node, ordered, index, itemId, baseOffset, raw));
        index++;
      }
    } while (cursor.nextSibling());
  }
  return items;
}

function buildListItemSnapshot(
  block: Block,
  listItemNode: any,
  ordered: boolean,
  index: number,
  id: string,
  baseOffset: number,
  raw: string,
): NodeSnapshot {
  const childSnapshots: NodeSnapshot[] = [];
  const segmentSnapshots: NodeSnapshot[] = [];
  let inlineNodes: InlineNode[] = [];
  let plainText = "";
  let paragraphHandled = false;
  let paragraphIndex = 0;
  let subListIndex = 0;
  let blockquoteIndex = 0;
  let codeIndex = 0;
  let htmlIndex = 0;
  let headingIndex = 0;
  let isTask = false;
  let taskChecked: boolean | undefined;

  const cursor = listItemNode.cursor();
  if (cursor.firstChild()) {
    do {
      const name = cursor.type.name;
      if (name === "ListMark") {
        continue;
      }
      if (name === "Paragraph") {
        const paragraphRaw = raw.slice(cursor.from, cursor.to);
        const meta = (block.payload.meta ?? {}) as { formatAnticipation?: FormatAnticipationConfig; mathEnabled?: boolean };
        const paragraphData = processListItemParagraph(paragraphRaw, {
          formatAnticipation: meta.formatAnticipation,
          math: meta.mathEnabled,
          streaming: !block.isFinalized,
        });
        const parsedInline = paragraphData.inline;
        if (!paragraphHandled) {
          inlineNodes = parsedInline;
          plainText = inlineNodesToPlainText(parsedInline);
          if (paragraphData.segments.length > 0) {
            paragraphData.segments.forEach((segment, segmentIndex) => {
              segmentSnapshots.push(createSegmentSnapshot(id, segment, segmentIndex, "list-item"));
            });
          }
          if (paragraphData.task) {
            isTask = true;
            taskChecked = paragraphData.task.checked;
          }
          paragraphHandled = true;
        } else {
          const paraId = `${id}::paragraph:${paragraphIndex++}`;
          const nestedSegments = paragraphData.segments;
          childSnapshots.push({
            id: paraId,
            type: "paragraph",
            props: {
              inline: cloneInlineNodes(parsedInline),
              text: inlineNodesToPlainText(parsedInline),
            },
            range: createRange(baseOffset + cursor.from, baseOffset + cursor.to),
            children: nestedSegments.map((segment, segmentIndex) => createSegmentSnapshot(paraId, segment, segmentIndex, "paragraph")),
          });
        }
      } else if (name === "BulletList" || name === "OrderedList") {
        const nestedId = `${id}::list:${subListIndex++}`;
        const nestedOrdered = name === "OrderedList";
        const nestedSnapshot = buildListNodeSnapshot(block, cursor.node, nestedOrdered, nestedId, baseOffset, raw);
        if (Array.isArray(nestedSnapshot.children) && nestedSnapshot.children.length > 0) {
          childSnapshots.push(nestedSnapshot);
        }
      } else if (name === "Blockquote") {
        const quoteId = `${id}::blockquote:${blockquoteIndex++}`;
        childSnapshots.push(buildBlockquoteSnapshot(block, cursor.node, quoteId, baseOffset, raw));
      } else if (name === "FencedCode" || name === "IndentedCode") {
        const codeId = `${id}::code:${codeIndex++}`;
        const isFenced = name === "FencedCode";
        const snapshot = buildCodeBlockSnapshot(block, cursor.node, codeId, baseOffset, raw, isFenced);
        if (snapshot) {
          childSnapshots.push(snapshot);
        }
      } else if (name === "HTMLBlock") {
        const htmlId = `${id}::html:${htmlIndex++}`;
        childSnapshots.push(buildHtmlSnapshot(block, cursor.node, htmlId, baseOffset, raw));
      } else if (name === "ATXHeading" || name === "SetextHeading") {
        const headingId = `${id}::heading:${headingIndex++}`;
        childSnapshots.push(buildHeadingSnapshot(block, cursor.node, headingId, baseOffset, raw));
      }
    } while (cursor.nextSibling());
  }

  const itemSnapshot: NodeSnapshot = {
    id,
    type: "list-item",
    props: {
      index,
      ordered,
      inline: cloneInlineNodes(inlineNodes),
      text: plainText,
      task: isTask,
      checked: isTask ? Boolean(taskChecked) : undefined,
    },
    range: createRange(baseOffset + listItemNode.from, baseOffset + listItemNode.to),
    children: [...segmentSnapshots, ...childSnapshots],
  };

  return itemSnapshot;
}

interface ListItemParagraphData {
  inline: InlineNode[];
  segments: MixedContentSegment[];
  task?: { checked: boolean };
}

type ListItemInlineOptions = {
  formatAnticipation?: FormatAnticipationConfig;
  math?: boolean;
  streaming?: boolean;
};

function parseListInline(raw: string, options?: ListItemInlineOptions): InlineNode[] {
  if (!options?.streaming || !options.formatAnticipation) {
    return listInlineParser.parse(raw);
  }
  const prepared = prepareInlineStreamingContent(raw, { formatAnticipation: options.formatAnticipation, math: options.math });
  if (prepared.kind === "raw") {
    return [{ kind: "text", text: raw }];
  }
  let preparedContent = prepared.content;
  let appended = prepared.appended;
  const normalized = normalizeFormatAnticipation(options.formatAnticipation);
  if (normalized.regex) {
    const regexAppend = listInlineParser.getRegexAnticipationAppend(raw);
    if (regexAppend) {
      preparedContent += regexAppend;
      appended += regexAppend;
    }
  }
  return listInlineParser.parse(preparedContent, { cache: false });
}

function processListItemParagraph(raw: string, options?: ListItemInlineOptions): ListItemParagraphData {
  const normalized = normalizeParagraphText(raw);
  const { content, task } = stripTaskMarker(normalized);
  const inline = parseListInline(content, options);
  const segments = extractMixedContentSegments(content, undefined, (value) => parseListInline(value, options));
  return {
    inline,
    segments,
    task,
  };
}

function stripTaskMarker(input: string): { content: string; task?: { checked: boolean } } {
  const taskMatch = input.match(/^\s*\[( |x|X|-)\][ \t]?/);
  if (!taskMatch) {
    return { content: input };
  }

  const marker = taskMatch[1];
  const checked = marker.toLowerCase() === "x";
  const remainder = input.slice(taskMatch[0].length).replace(/^\s+/, "");
  return {
    content: remainder,
    task: { checked },
  };
}

function buildBlockquoteSnapshot(block: Block, quoteNode: any, id: string, baseOffset: number, raw: string): NodeSnapshot {
  const quoteRaw = raw.slice(quoteNode.from, quoteNode.to);
  const normalized = normalizeBlockquoteText(quoteRaw);
  const inline = listInlineParser.parse(normalized);
  const segments = extractMixedContentSegments(normalized, undefined, (value) => listInlineParser.parse(value));

  const quoteBlock: Block = {
    id,
    type: "blockquote",
    isFinalized: true,
    payload: {
      raw: normalized,
      inline: cloneInlineNodes(inline),
      meta: segments.some((segment) => segment.kind !== "text")
        ? {
            mixedSegments: segments,
          }
        : undefined,
      range: createRange(baseOffset + quoteNode.from, baseOffset + quoteNode.to),
    },
  };

  return createBlockSnapshot(quoteBlock);
}

function buildCodeBlockSnapshot(block: Block, codeNode: any, id: string, baseOffset: number, raw: string, _isFenced: boolean): NodeSnapshot | null {
  const segment = raw.slice(codeNode.from, codeNode.to);
  const normalized = stripListIndentation(segment);
  const { code, info: infoString, hadFence } = stripCodeFence(normalized);
  const body = hadFence ? code : dedentIndentedCode(normalized);
  const { lang, meta } = parseCodeFenceInfo(infoString);
  const codeBlock: Block = {
    id,
    type: "code",
    isFinalized: true,
    payload: {
      raw: normalized,
      meta: { ...meta, lang: lang || "text", code: body },
      range: createRange(baseOffset + codeNode.from, baseOffset + codeNode.to),
    },
  };
  return createBlockSnapshot(codeBlock);
}

function buildHtmlSnapshot(block: Block, htmlNode: any, id: string, baseOffset: number, raw: string): NodeSnapshot {
  const htmlRaw = stripListIndentation(raw.slice(htmlNode.from, htmlNode.to));
  const htmlBlock: Block = {
    id,
    type: "html",
    isFinalized: true,
    payload: {
      raw: htmlRaw,
      sanitizedHtml: undefined,
      meta: undefined,
      range: createRange(baseOffset + htmlNode.from, baseOffset + htmlNode.to),
    },
  };
  return createBlockSnapshot(htmlBlock);
}

function buildHeadingSnapshot(block: Block, headingNode: any, id: string, baseOffset: number, raw: string): NodeSnapshot {
  const headingRaw = stripListIndentation(raw.slice(headingNode.from, headingNode.to));
  const inline = listInlineParser.parse(removeHeadingMarkers(headingRaw));
  const headingBlock: Block = {
    id,
    type: "heading",
    isFinalized: true,
    payload: {
      raw: headingRaw,
      inline: cloneInlineNodes(inline),
      range: createRange(baseOffset + headingNode.from, baseOffset + headingNode.to),
    },
  };
  return createBlockSnapshot(headingBlock);
}

function buildListNodeSnapshot(block: Block, listNode: any, ordered: boolean, id: string, baseOffset: number, raw: string): NodeSnapshot {
  return {
    id,
    type: "list",
    props: {
      ordered,
    },
    range: createRange(baseOffset + listNode.from, baseOffset + listNode.to),
    children: buildListItemSnapshots(block, listNode, ordered, id, baseOffset, raw),
  };
}

function enrichParagraphSnapshot(block: Block, snapshot: NodeSnapshot): NodeSnapshot {
  const meta = block.payload.meta as { mixedSegments?: MixedContentSegment[] } | undefined;
  const segments = Array.isArray(meta?.mixedSegments) ? (meta?.mixedSegments ?? []) : [];
  if (!segments.length) {
    return snapshot;
  }

  snapshot.children = segments.map((segment, index) => createSegmentSnapshot(block.id, segment, index, "paragraph"));
  return snapshot;
}

function enrichBlockquoteSnapshot(block: Block, snapshot: NodeSnapshot): NodeSnapshot {
  const meta = block.payload.meta as { mixedSegments?: MixedContentSegment[] } | undefined;
  const segments = Array.isArray(meta?.mixedSegments) ? (meta?.mixedSegments ?? []) : [];
  if (!segments.length) {
    return snapshot;
  }

  snapshot.children = segments.map((segment, index) => createSegmentSnapshot(block.id, segment, index, "blockquote"));
  return snapshot;
}

function createSegmentSnapshot(
  parentId: string,
  segment: MixedContentSegment,
  index: number,
  parentType: "paragraph" | "blockquote" | "list-item",
): NodeSnapshot {
  const id = `${parentId}::${parentType}:segment:${index}`;
  const range = segment.range ? { ...segment.range } : undefined;
  switch (segment.kind) {
    case "html":
      return {
        id,
        type: `${parentType}-html`,
        props: {
          html: segment.sanitized ?? segment.value,
          raw: segment.value,
        },
        meta: segment.sanitized ? { sanitized: true } : undefined,
        range,
        children: [],
      };
    case "mdx":
      return {
        id,
        type: `${parentType}-mdx`,
        props: {
          raw: segment.value,
          status: segment.status ?? "pending",
          error: segment.error,
        },
        range,
        children: [],
      };
    default:
      return {
        id,
        type: `${parentType}-text`,
        props: {
          text: segment.value,
          inline: segment.inline ? cloneInlineNodes(segment.inline) : undefined,
        },
        range,
        children: [],
      };
  }
}

function fallbackListSnapshot(block: Block, snapshot: NodeSnapshot): NodeSnapshot {
  const meta = block.payload.meta as { ordered?: boolean; items?: InlineNode[][] } | undefined;
  const ordered = Boolean(meta?.ordered);
  const items = Array.isArray(meta?.items) ? (meta?.items as InlineNode[][]) : [];
  snapshot.props = { ...(snapshot.props ?? {}), ordered, items: undefined };
  snapshot.children = items.map((inlineNodes, index) => ({
    id: `${block.id}::item:${index}`,
    type: "list-item",
    props: {
      index,
      ordered,
      inline: cloneInlineNodes(inlineNodes),
      text: inlineNodesToPlainText(inlineNodes),
    },
    children: [],
  }));
  return snapshot;
}

function normalizeParagraphText(input: string): string {
  if (!input) return "";
  const lines = input.split("\n");
  let minIndent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) continue;
    const match = line.match(/^(\s*)/);
    const indent = match ? match[1].length : 0;
    minIndent = Math.min(minIndent, indent);
  }
  if (!Number.isFinite(minIndent)) {
    return "";
  }
  return lines
    .map((line) => (line.length >= minIndent ? line.slice(minIndent) : line))
    .join("\n")
    .trim();
}

function stripListIndentation(input: string): string {
  if (!input) return "";
  const lines = input.split("\n");
  let minIndent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) continue;
    const match = line.match(/^(\s*)/);
    const indent = match ? match[1].length : 0;
    minIndent = Math.min(minIndent, indent);
  }
  if (!Number.isFinite(minIndent) || minIndent === 0) {
    return input.trim();
  }
  return lines
    .map((line) => (line.length >= minIndent ? line.slice(minIndent) : ""))
    .join("\n")
    .trim();
}

function parseFencedCodeSegment(input: string): { infoString: string; code: string } | null {
  const normalized = input.replace(/\r\n/g, "\n").trim();
  const match = normalized.match(/^```([^\n]*)\n([\s\S]*?)\n?```$/);
  if (!match) return null;
  const infoString = match[1] ? match[1].trim() : "";
  const code = match[2] ? match[2].replace(/\n?$/, "") : "";
  return { infoString, code };
}

function dedentIndentedCode(input: string): string {
  if (!input) return "";
  const lines = input.split("\n");
  let minIndent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const match = line.match(/^(\s*)/);
    const indent = match ? match[1].length : 0;
    minIndent = Math.min(minIndent, indent);
  }
  if (!Number.isFinite(minIndent)) {
    return input.trim();
  }
  return lines
    .map((line) => (line.length >= minIndent ? line.slice(minIndent) : ""))
    .join("\n")
    .trimEnd();
}

function removeHeadingMarkers(input: string): string {
  return input
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+={2,}\s*$|\s+-{2,}\s*$/m, "")
    .trim();
}

function createRange(from: number, to: number): { from: number; to: number } | undefined {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
    return undefined;
  }
  return { from, to };
}

function enrichTableSnapshot(block: Block, snapshot: NodeSnapshot): NodeSnapshot {
  const meta = block.payload.meta as
    | {
        header?: InlineNode[][];
        rows?: InlineNode[][][];
        align?: Array<"left" | "center" | "right" | null>;
      }
    | undefined;
  const header = Array.isArray(meta?.header) ? (meta?.header as InlineNode[][]) : [];
  const rows = Array.isArray(meta?.rows) ? (meta?.rows as InlineNode[][][]) : [];
  const align = Array.isArray(meta?.align) ? (meta?.align ?? []) : [];

  const children: NodeSnapshot[] = [];

  if (header.length > 0) {
    children.push({
      id: `${block.id}::thead`,
      type: "table-header",
      props: { columns: header.length },
      children: header.map((cellInline, cellIndex) => ({
        id: `${block.id}::th:${cellIndex}`,
        type: "table-header-cell",
        props: {
          index: cellIndex,
          align: align[cellIndex] ?? null,
          inline: cloneInlineNodes(cellInline),
          text: inlineNodesToPlainText(cellInline),
        },
        children: [],
      })),
    });
  }

  const bodyChildren = rows.map((rowCells, rowIndex) => ({
    id: `${block.id}::row:${rowIndex}`,
    type: "table-row",
    props: { index: rowIndex },
    children: rowCells.map((cellInline, cellIndex) => ({
      id: `${block.id}::td:${rowIndex}:${cellIndex}`,
      type: "table-cell",
      props: {
        rowIndex,
        index: cellIndex,
        align: align[cellIndex] ?? null,
        inline: cloneInlineNodes(cellInline),
        text: inlineNodesToPlainText(cellInline),
      },
      children: [],
    })),
  }));

  children.push({
    id: `${block.id}::tbody`,
    type: "table-body",
    props: { rows: rows.length },
    children: bodyChildren,
  });

  snapshot.children = children;
  return snapshot;
}

function enrichCodeSnapshot(block: Block, snapshot: NodeSnapshot): NodeSnapshot {
  const source = typeof block.payload.meta?.code === "string" ? (block.payload.meta?.code as string) : (block.payload.raw ?? "");
  const lines = extractCodeLines(source);
  const meta = block.payload.meta as { highlightedLines?: HighlightedLine[]; lang?: string } | undefined;
  const highlightedHtml = block.payload.highlightedHtml ?? "";
  const hasBlockHighlight = typeof block.payload.highlightedHtml === "string" && block.payload.highlightedHtml.length > 0;
  const metaLines = Array.isArray(meta?.highlightedLines) ? (meta?.highlightedLines as HighlightedLine[]) : null;
  const includeLineHtml = metaLines ? true : !hasBlockHighlight || lines.length >= 200;
  const highlightedLines = metaLines
    ? normalizeHighlightedLines(metaLines, lines.length)
    : extractHighlightedLines(highlightedHtml, lines.length);
  const lang = typeof meta?.lang === "string" ? String(meta.lang) : undefined;
  let { preAttrs, codeAttrs } = extractCodeWrapperAttributes(highlightedHtml);
  if (!preAttrs || !codeAttrs) {
    const defaults = getDefaultCodeWrapperAttributes(lang);
    preAttrs = preAttrs ?? defaults.preAttrs;
    codeAttrs = codeAttrs ?? defaults.codeAttrs;
  }
  snapshot.props = {
    ...(snapshot.props ?? {}),
    lang,
    preAttrs,
    codeAttrs,
  };
  snapshot.children = lines.map((line, index) => ({
    id: `${block.id}::line:${index}`,
    type: "code-line",
    props: {
      index,
      text: line,
      html: includeLineHtml ? (highlightedLines[index] ?? null) : null,
    },
    children: [],
  }));
  return snapshot;
}

function cloneInlineNodes(nodes: InlineNode[]): InlineNode[] {
  return nodes.map((node) => {
    if ("children" in node && Array.isArray(node.children)) {
      return { ...node, children: cloneInlineNodes(node.children) };
    }
    return { ...node };
  });
}

export function inlineNodesToPlainText(nodes: InlineNode[]): string {
  let result = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        result += node.text;
        break;
      case "code":
        result += node.text;
        break;
      case "link":
      case "strong":
      case "em":
      case "mention":
      case "citation":
      case "math-inline":
      case "math-display":
        if ("children" in node && Array.isArray(node.children)) {
          result += inlineNodesToPlainText(node.children);
        } else if ("text" in node && typeof node.text === "string") {
          result += node.text;
        }
        break;
      case "footnote-ref":
        result += `[^${node.label}]`;
        break;
      case "image":
        result += node.alt ?? "";
        break;
      default:
        break;
    }
  }
  return result;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== (b as unknown[]).length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], (b as unknown[])[i])) return false;
    }
    return true;
  }

  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

type StructuredCloneFn = (value: unknown) => unknown;

function structuredCloneIfPossible<T>(value: T): T {
  const globalClone = (globalThis as { structuredClone?: StructuredCloneFn }).structuredClone;
  if (typeof globalClone === "function") {
    try {
      return globalClone(value) as T;
    } catch {
      // fall through to JSON cloning
    }
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * Lightweight document snapshot utilities for worker-driven streaming.
 * These helpers maintain a minimal node tree so non-React environments
 * (e.g., TUIs) can apply worker patches and materialize Block arrays.
 */

interface SnapshotNode {
  id: string;
  type: string;
  parentId: string | null;
  children: string[];
  props: Record<string, unknown>;
  block?: Block;
}

export interface DocumentSnapshot {
  nodes: Map<string, SnapshotNode>;
  rootId: string;
  blocks: Block[];
}

export function createInitialSnapshot(initialBlocks: Block[] = []): DocumentSnapshot {
  const nodes = new Map<string, SnapshotNode>();
  const root: SnapshotNode = {
    id: PATCH_ROOT_ID,
    type: "__root__",
    parentId: null,
    children: [],
    props: {},
  };
  nodes.set(root.id, root);

  const snapshot: DocumentSnapshot = {
    nodes,
    rootId: root.id,
    blocks: [],
  };

  for (const block of initialBlocks) {
    const blockSnapshot = createBlockSnapshot(cloneBlock(block));
    insertSnapshotAt(snapshot, root, root.children.length, blockSnapshot);
  }

  snapshot.blocks = buildBlocks(snapshot);
  return snapshot;
}

export function applyPatchBatch(snapshot: DocumentSnapshot, patches: Patch[]): Block[] {
  if (!snapshot || !Array.isArray(patches) || patches.length === 0) {
    return snapshot?.blocks ?? [];
  }

  for (const patch of patches) {
    switch (patch.op) {
      case "insertChild": {
        const parent = resolveParentNode(snapshot, patch.at);
        if (!parent) break;
        insertSnapshotAt(snapshot, parent, patch.index, patch.node);
        break;
      }
      case "deleteChild": {
        const parent = resolveParentNode(snapshot, patch.at);
        if (!parent) break;
        if (patch.index < 0 || patch.index >= parent.children.length) break;
        const childId = parent.children.splice(patch.index, 1)[0];
        if (childId) {
          removeSubtree(snapshot, childId);
        }
        break;
      }
      case "replaceChild": {
        const parent = resolveParentNode(snapshot, patch.at);
        if (!parent) break;
        if (patch.index < 0 || patch.index >= parent.children.length) break;
        const targetId = parent.children[patch.index];
        if (targetId) {
          removeSubtree(snapshot, targetId);
        }
        insertSnapshotAt(snapshot, parent, patch.index, patch.node);
        break;
      }
      case "setProps": {
        const target = resolveTargetNode(snapshot, patch.at);
        if (!target) break;
        applyPropsToNode(target, patch.props);
        break;
      }
      case "setPropsBatch": {
        const entries = Array.isArray(patch.entries) ? (patch.entries as SetPropsBatchEntry[]) : [];
        for (const entry of entries) {
          if (!entry?.at) continue;
          const target = resolveTargetNode(snapshot, entry.at);
          if (!target) continue;
          applyPropsToNode(target, entry.props);
        }
        break;
      }
      case "finalize": {
        const target = resolveTargetNode(snapshot, patch.at);
        if (!target?.block) break;
        target.block = cloneBlock(target.block);
        target.block.isFinalized = true;
        break;
      }
      case "reorder": {
        const parent = resolveParentNode(snapshot, patch.at);
        if (!parent || parent.children.length === 0) break;
        const length = parent.children.length;
        const from = clamp(patch.from, 0, length - 1);
        const count = Math.max(1, Math.min(patch.count, length - from));
        let to = clamp(patch.to, 0, length);
        if (to > from) {
          to = Math.max(0, to - count);
        }
        const moved = parent.children.splice(from, count);
        parent.children.splice(to, 0, ...moved);
        break;
      }
      case "appendLines": {
        const parent = resolveTargetNode(snapshot, patch.at);
        if (!parent) break;
        appendLinesToCodeNode(snapshot, parent, patch.startIndex, patch.lines ?? [], patch.highlight ?? []);
        break;
      }
      case "setHTML": {
        const target = resolveTargetNode(snapshot, patch.at);
        if (!target) break;
        const props: Record<string, unknown> = {
          html: patch.html,
          policy: patch.policy,
          meta: patch.meta,
        };
        if (patch.block) {
          props.block = patch.block;
        }
        applyPropsToNode(target, props);
        break;
      }
      default:
        break;
    }
  }

  snapshot.blocks = buildBlocks(snapshot);
  return snapshot.blocks;
}

function buildBlocks(snapshot: DocumentSnapshot): Block[] {
  const root = snapshot.nodes.get(snapshot.rootId);
  if (!root) {
    return [];
  }
  const result: Block[] = [];
  for (const childId of root.children) {
    const child = snapshot.nodes.get(childId);
    if (child?.block) {
      result.push(cloneBlock(child.block));
    }
  }
  return result;
}

function insertSnapshotAt(snapshot: DocumentSnapshot, parent: SnapshotNode, index: number, nodeSnapshot: NodeSnapshot): SnapshotNode | null {
  if (!parent) return null;
  removeSubtree(snapshot, nodeSnapshot.id);
  const node = buildNodeFromSnapshot(snapshot, nodeSnapshot, parent.id);
  if (!node) return null;
  const clamped = clamp(index, 0, parent.children.length);
  parent.children.splice(clamped, 0, node.id);
  return node;
}

function buildNodeFromSnapshot(snapshot: DocumentSnapshot, snapshotNode: NodeSnapshot, parentId: string | null): SnapshotNode | null {
  if (!snapshotNode || !snapshotNode.id) {
    return null;
  }
  const props = { ...(snapshotNode.props ?? {}) };
  let block: Block | undefined;
  if (props.block && typeof props.block === "object") {
    block = cloneBlock(props.block as Block);
    delete props.block;
  }

  const node: SnapshotNode = {
    id: snapshotNode.id,
    type: snapshotNode.type,
    parentId,
    children: [],
    props,
    block,
  };

  snapshot.nodes.set(node.id, node);

  const childSnapshots = Array.isArray(snapshotNode.children) ? snapshotNode.children : [];
  for (const child of childSnapshots) {
    const built = buildNodeFromSnapshot(snapshot, child, node.id);
    if (built) {
      node.children.push(built.id);
    }
  }

  return node;
}

function removeSubtree(snapshot: DocumentSnapshot, nodeId: string) {
  const node = snapshot.nodes.get(nodeId);
  if (!node) return;
  for (const childId of [...node.children]) {
    removeSubtree(snapshot, childId);
  }
  snapshot.nodes.delete(node.id);
  if (node.parentId) {
    const parent = snapshot.nodes.get(node.parentId);
    if (parent) {
      parent.children = parent.children.filter((id) => id !== node.id);
    }
  }
}

function resolveParentNode(snapshot: DocumentSnapshot, path: NodePath): SnapshotNode | null {
  if (!path) return null;
  if (path.nodeId) {
    return snapshot.nodes.get(path.nodeId) ?? null;
  }
  if (path.blockId === PATCH_ROOT_ID) {
    return snapshot.nodes.get(snapshot.rootId) ?? null;
  }
  return snapshot.nodes.get(path.blockId) ?? null;
}

function resolveTargetNode(snapshot: DocumentSnapshot, path: NodePath): SnapshotNode | null {
  if (!path) return null;
  if (path.nodeId) {
    return snapshot.nodes.get(path.nodeId) ?? null;
  }
  return snapshot.nodes.get(path.blockId) ?? null;
}

function applyPropsToNode(node: SnapshotNode, props: Record<string, unknown> | undefined) {
  if (!node || !props) return;
  const next = { ...node.props };
  for (const [key, value] of Object.entries(props)) {
    if (key === "block" && value && typeof value === "object") {
      node.block = cloneBlock(value as Block);
      continue;
    }
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  node.props = next;
}

function appendLinesToCodeNode(
  snapshot: DocumentSnapshot,
  parent: SnapshotNode,
  startIndex: number,
  lines: string[],
  highlights: Array<string | null>,
) {
  if (parent.type !== "code") return;
  const insertionIndex = Math.max(0, Math.min(startIndex, parent.children.length));
  let currentIndex = insertionIndex;
  for (let i = 0; i < lines.length; i++) {
    const lineId = `${parent.id}::line:${currentIndex}`;
    removeSubtree(snapshot, lineId);
    const child: SnapshotNode = {
      id: lineId,
      type: "code-line",
      parentId: parent.id,
      children: [],
      props: {
        index: currentIndex,
        text: lines[i] ?? "",
        html: highlights[i] ?? null,
      },
    };
    snapshot.nodes.set(child.id, child);
    parent.children.splice(currentIndex, 0, child.id);
    currentIndex++;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
