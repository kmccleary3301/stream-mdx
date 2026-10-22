declare const __STREAM_MDX_COUNTERS__: boolean;

import { parser as baseMdParser, GFM } from "@lezer/markdown";
import { AppendSourceDocument, createSourceWindow, type SourceSnapshot } from "./source-document";
import {
  createCodeLineIndex,
  type CodeLineDecorationUpdate,
  type CodeLineIndex,
  type CodeLineRecord,
} from "./code-records";
import {
  appendManagedTableRows,
  createManagedTableState,
  materializeManagedTableSnapshot,
  updateManagedTableRows,
  type ManagedTablePatchResult,
  type ManagedTableViewState,
} from "./table-block-state";
import {
  appendManagedParagraphSpans,
  createManagedParagraphState,
  materializeManagedParagraphSnapshot,
  updateManagedParagraphSpans,
  type ManagedParagraphPatchResult,
  type ManagedParagraphViewState,
} from "./paragraph-block-state";
import {
  extractCodeLines,
  extractCodeWrapperAttributes,
  extractHighlightedLines,
  getDefaultCodeWrapperAttributes,
  normalizeHighlightedLines,
  type HighlightedLine,
} from "./code-highlighting";
import { InlineParser } from "./inline-parser";
import { prepareNestedBlockSnapshot, type PreparedNestedSnapshot } from "./nested-block-snapshot";
import { createBlockCompatibilityExtension } from "./block-compatibility";
import type { TableBlockSnapshot, TableCellRecord, TableHeaderRecord, TableRowRecord } from "./table-records";
import type { ParagraphBlockSnapshot, ParagraphSpanRecord } from "./paragraph-records";
import type {
  Block,
  CodeBlockSnapshot,
  CodeBlockSourceMetadata,
  DiffLineKind,
  HtmlTreeNode,
  InlineNode,
  MixedContentSegment,
  NodeSnapshot,
  NodePath,
  Patch,
  SetPropsBatchEntry,
  TokenLineV1,
} from "./types";
import { PATCH_ROOT_ID } from "./types";

export function cloneBlock(block: Block): Block {
  return {
    ...block,
    payload: {
      ...block.payload,
      inline: block.payload.inline ? cloneInlineNodes(block.payload.inline) : undefined,
      highlightedHtml: block.payload.highlightedHtml,
      sanitizedHtml: block.payload.sanitizedHtml,
      meta: block.payload.meta ? structuredCloneIfPossible(block.payload.meta) : undefined,
      range: block.payload.range ? { ...block.payload.range } : undefined,
    },
  };
}

export function blocksStructurallyEqual(a: Block, b: Block): boolean {
  if (a === b) return true;
  if (a.type !== b.type) return false;
  if (a.isFinalized !== b.isFinalized) return false;
  if (a.payload.raw !== b.payload.raw) return false;
  const metaA = a.payload.meta ?? null;
  const metaB = b.payload.meta ?? null;
  if (!deepEqual(metaA, metaB)) return false;
  const inlineA = a.payload.inline ?? null;
  const inlineB = b.payload.inline ?? null;
  if (!deepEqual(inlineA, inlineB)) return false;
  return true;
}

function managedTableSnapshot(block: Block): TableBlockSnapshot | undefined {
  if (block.type !== "table") return undefined;
  const candidate = block.payload.meta?.table;
  if (!candidate || typeof candidate !== "object") return undefined;
  const table = candidate as Partial<TableBlockSnapshot>;
  return table.tableOwnerId === block.id &&
    typeof table.raw === "string" &&
    Boolean(table.header && Array.isArray(table.header.cells) && Array.isArray(table.rows))
    ? candidate as TableBlockSnapshot
    : undefined;
}

function stripManagedTableMetadata(block: Block): Block {
  const meta = block.payload.meta ? { ...block.payload.meta } : undefined;
  if (meta) {
    delete meta.table;
    delete meta.header;
    delete meta.rows;
    delete meta.align;
  }
  return { ...block, payload: { ...block.payload, raw: "", meta } };
}
function managedParagraphSnapshot(block: Block): ParagraphBlockSnapshot | undefined {
  if (block.type !== "paragraph") return undefined;
  const candidate = block.payload.meta?.paragraph;
  if (!candidate || typeof candidate !== "object") return undefined;
  const paragraph = candidate as Partial<ParagraphBlockSnapshot>;
  return paragraph.paragraphOwnerId === block.id &&
    typeof paragraph.raw === "string" &&
    Array.isArray(paragraph.spans)
    ? candidate as ParagraphBlockSnapshot
    : undefined;
}

function stripManagedParagraphMetadata(block: Block): Block {
  const meta = block.payload.meta ? { ...block.payload.meta } : undefined;
  if (meta) {
    delete meta.paragraph;
    delete meta.mixedSegments;
    delete meta.mixedHtmlTrees;
  }
  return { ...block, payload: { ...block.payload, raw: "", inline: undefined, meta } };
}

function paragraphSourceSlice(paragraph: ParagraphBlockSnapshot, range: { readonly from: number; readonly to: number }): string {
  const base = paragraph.sourceRange.from;
  if (range.from < base || range.to < range.from || range.to > paragraph.sourceRange.to) {
    throw new RangeError("Paragraph child range is outside its source owner");
  }
  return paragraph.raw.slice(range.from - base, range.to - base);
}

function materializeParagraphMixedSegments(
  paragraph: ParagraphBlockSnapshot,
): { readonly segments: MixedContentSegment[]; readonly htmlTrees: Record<number, HtmlTreeNode[]> } | undefined {
  if (!paragraph.spans.some((span) => (span.children?.length ?? 0) > 0)) return undefined;
  const segments: MixedContentSegment[] = [];
  const htmlTrees: Record<number, HtmlTreeNode[]> = {};
  const appendText = (from: number, to: number, inline?: readonly InlineNode[]): void => {
    if (to <= from) return;
    const range = { from, to };
    segments.push({
      kind: "text",
      value: paragraphSourceSlice(paragraph, range),
      range,
      ...(inline ? { inline: cloneInlineNodes(inline) } : {}),
    });
  };
  let cursor = paragraph.sourceRange.from;
  for (const span of paragraph.spans) {
    if (span.sourceRange.from < cursor || span.sourceRange.to > paragraph.sourceRange.to) {
      throw new RangeError("Paragraph spans overlap or exceed their source owner");
    }
    appendText(cursor, span.sourceRange.from);
    if (!span.children?.length) {
      appendText(span.sourceRange.from, span.sourceRange.to, span.nodes);
      cursor = span.sourceRange.to;
      continue;
    }
    if (span.nodes.length !== 0) throw new TypeError("Mixed paragraph spans must use children as their sole meaning");
    let childCursor = span.sourceRange.from;
    for (const child of span.children) {
      const range = child.range;
      if (range.from < childCursor || range.to > span.sourceRange.to) {
        throw new RangeError("Paragraph child ranges overlap or exceed their span");
      }
      appendText(childCursor, range.from);
      const source = paragraphSourceSlice(paragraph, range);
      const props = child.props ?? {};
      if (child.type === "paragraph-text") {
        if (!Array.isArray(props.inline)) throw new TypeError("Paragraph text child is missing prepared inline nodes");
        segments.push({ kind: "text", value: source, inline: cloneInlineNodes(props.inline as InlineNode[]), range: { ...range } });
      } else if (child.type === "paragraph-html") {
        const segment: MixedContentSegment = { kind: "html", value: typeof props.raw === "string" ? props.raw : source, range: { ...range } };
        if (child.meta?.sanitized === true && typeof props.html === "string") segment.sanitized = props.html;
        if (Array.isArray(props.htmlTree)) htmlTrees[segments.length] = props.htmlTree as HtmlTreeNode[];
        segments.push(segment);
      } else if (child.type === "paragraph-mdx") {
        segments.push({ kind: "mdx", value: typeof props.raw === "string" ? props.raw : source, range: { ...range } });
      } else {
        throw new TypeError(`Unsupported native paragraph child type: ${child.type}`);
      }
      childCursor = range.to;
    }
    appendText(childCursor, span.sourceRange.to);
    cursor = span.sourceRange.to;
  }
  appendText(cursor, paragraph.sourceRange.to);
  return { segments, htmlTrees };
}

export function materializeManagedParagraphBlock(block: Block, state: ManagedParagraphViewState): Block {
  const paragraph = materializeManagedParagraphSnapshot(state);
  const result = cloneBlock(block);
  const mixed = materializeParagraphMixedSegments(paragraph);
  result.payload.raw = paragraph.raw;
  result.payload.inline = mixed ? [] : paragraph.spans.flatMap((span) => cloneInlineNodes(span.nodes));
  result.payload.range = { ...paragraph.sourceRange };
  const meta: NonNullable<Block["payload"]["meta"]> = { ...(result.payload.meta ?? {}), paragraph };
  if (mixed) {
    meta.mixedSegments = mixed.segments;
    if (Object.keys(mixed.htmlTrees).length > 0) meta.mixedHtmlTrees = mixed.htmlTrees;
    else delete meta.mixedHtmlTrees;
  } else {
    delete meta.mixedSegments;
    delete meta.mixedHtmlTrees;
  }
  result.payload.meta = meta;
  result.isFinalized = paragraph.state !== "open";
  return result;
}

export function materializeManagedTableBlock(block: Block, state: ManagedTableViewState): Block {
  const sourceTable = materializeManagedTableSnapshot(state);
  const table: TableBlockSnapshot = {
    ...sourceTable,
    generation: 0,
    revision: 0,
    processedTo: sourceTable.sourceRange.to,
    rows: sourceTable.rows.map((row) => Object.freeze({ ...row, sourceRevision: 0 })),
  };
  const result = cloneBlock(block);
  const meta = { ...(result.payload.meta ?? {}) };
  meta.table = table;
  meta.header = table.header.cells.map((cell) => cloneInlineNodes(cell.inline));
  meta.rows = table.rows.map((row) => row.cells.map((cell) => cloneInlineNodes(cell.inline)));
  meta.align = [...table.header.align];
  result.payload.meta = meta;
  result.payload.raw = table.raw;
  result.payload.range = { ...table.sourceRange };
  result.isFinalized = state.source.state !== "open";
  return result;
}

export function createBlockSnapshot(block: Block): NodeSnapshot;
export function createBlockSnapshot(
  block: Block,
  onNodeCreated?: (node: NodeSnapshot) => void,
): NodeSnapshot {
  const table = managedTableSnapshot(block);
  const paragraph = managedParagraphSnapshot(block);
  const blockForSnapshot = cloneBlock(
    table ? stripManagedTableMetadata(block) : paragraph ? stripManagedParagraphMetadata(block) : block,
  );
  const tableSnapshot = table ? structuredCloneIfPossible(table) : undefined;
  const paragraphSnapshot = paragraph ? structuredCloneIfPossible(paragraph) : undefined;
  const base: NodeSnapshot = {
    id: block.id,
    type: block.type,
    props: {
      block: blockForSnapshot,
    },
    meta: blockForSnapshot.payload.meta ? structuredCloneIfPossible(blockForSnapshot.payload.meta) : undefined,
    range: block.payload.range ? { ...block.payload.range } : undefined,
    table: tableSnapshot,
    paragraph: paragraphSnapshot,
    children: [],
  };
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    onNodeCreated?.(base);
  }

  switch (block.type) {
    case "paragraph":
      if (paragraph) return base;
      return (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__)
        ? enrichParagraphSnapshot(block, base, onNodeCreated)
        : enrichParagraphSnapshot(block, base);
    case "blockquote":
      return (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__)
        ? enrichContainerSnapshot(block, base, onNodeCreated)
        : enrichContainerSnapshot(block, base);
    case "list":
      return (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__)
        ? enrichContainerSnapshot(block, base, onNodeCreated)
        : enrichContainerSnapshot(block, base);
    case "list-item":
      if (block.payload.meta?.preparedNested) {
        return (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__)
          ? enrichContainerSnapshot(block, base, onNodeCreated)
          : enrichContainerSnapshot(block, base);
      }
      return base;
    case "table":
      return (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__)
        ? enrichTableSnapshot(block, base, onNodeCreated)
        : enrichTableSnapshot(block, base);
    case "html": {
      if (block.payload.meta?.preparedNested) {
        return (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__)
          ? enrichContainerSnapshot(block, base, onNodeCreated)
          : enrichContainerSnapshot(block, base);
      }
      const htmlTree = block.payload.meta?.htmlTree;
      if (Array.isArray(htmlTree)) {
        base.children = (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__)
          ? createHtmlTreeBlockSnapshots(htmlTree, onNodeCreated)
          : createHtmlTreeBlockSnapshots(htmlTree);
      }
      return base;
    }
    case "code":
      return (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__)
        ? enrichCodeSnapshot(block, base, onNodeCreated)
        : enrichCodeSnapshot(block, base);
    default:
      return base;
  }
}

function countClonedDescendants(nodes: NodeSnapshot[], cb: (node: NodeSnapshot) => void): void {
  for (const node of nodes) {
    cb(node);
    if (Array.isArray(node.children) && node.children.length > 0) {
      countClonedDescendants(node.children, cb);
    }
  }
}

function enrichContainerSnapshot(
  block: Block,
  snapshot: NodeSnapshot,
  onNodeCreated?: (node: NodeSnapshot) => void,
): NodeSnapshot {
  const prepared = block.payload.meta?.preparedNested as PreparedNestedSnapshot | undefined;
  const nested = prepared ?? prepareNestedBlockSnapshot(
    block,
    new InlineParser({ enableMath: block.payload.meta?.mathEnabled !== false }),
    baseMdParser.configure([GFM, createBlockCompatibilityExtension()]),
  );
  snapshot.props = { ...snapshot.props, ...structuredCloneIfPossible(nested.props) };
  const clonedChildren = structuredCloneIfPossible(nested.children);
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    if (onNodeCreated && Array.isArray(clonedChildren)) {
      countClonedDescendants(clonedChildren, onNodeCreated);
    }
  }
  snapshot.children = clonedChildren;
  return snapshot;
}
function createHtmlTreeBlockSnapshots(
  nodes: readonly HtmlTreeNode[],
  onNodeCreated?: (node: NodeSnapshot) => void,
): NodeSnapshot[] {
  const snapshots: NodeSnapshot[] = [];
  const append = (tree: readonly HtmlTreeNode[]): void => {
    for (const node of tree) {
      if (node.kind === "block") {
        const snapshot = createBlockSnapshot(node.block);
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && onNodeCreated) {
          countClonedDescendants([snapshot], onNodeCreated);
        }
        snapshots.push(snapshot);
      } else if (node.kind === "element") {
        append(node.children);
      }
    }
  };
  append(nodes);
  return snapshots;
}


function enrichParagraphSnapshot(
  block: Block,
  snapshot: NodeSnapshot,
  onNodeCreated?: (node: NodeSnapshot) => void,
): NodeSnapshot {
  const meta = block.payload.meta as { mixedSegments?: MixedContentSegment[]; mixedHtmlTrees?: Record<number, HtmlTreeNode[]> } | undefined;
  const segments = Array.isArray(meta?.mixedSegments) ? (meta?.mixedSegments ?? []) : [];
  if (!segments.length) {
    return snapshot;
  }

  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && onNodeCreated) {
    snapshot.children = segments.map((segment, index) => {
      const segNode = createSegmentSnapshot(block.id, segment, index, "paragraph", meta?.mixedHtmlTrees?.[index], onNodeCreated);
      onNodeCreated(segNode);
      return segNode;
    });
  } else {
    snapshot.children = segments.map((segment, index) =>
      createSegmentSnapshot(block.id, segment, index, "paragraph", meta?.mixedHtmlTrees?.[index], onNodeCreated));
  }
  return snapshot;
}


function createSegmentSnapshot(
  parentId: string,
  segment: MixedContentSegment,
  index: number,
  parentType: "paragraph" | "blockquote" | "list-item",
  htmlTree?: HtmlTreeNode[],
  onNodeCreated?: (node: NodeSnapshot) => void,
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
          ...(htmlTree !== undefined ? { htmlTree } : {}),
        },
        meta: segment.sanitized ? { sanitized: true } : undefined,
        range,
        children: htmlTree === undefined ? [] : createHtmlTreeBlockSnapshots(htmlTree, onNodeCreated),
      };
    case "mdx":
      return {
        id,
        type: `${parentType}-mdx`,
        props: {
          raw: segment.value,
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


function enrichTableSnapshot(
  block: Block,
  snapshot: NodeSnapshot,
  onNodeCreated?: (node: NodeSnapshot) => void,
): NodeSnapshot {
  if (snapshot.table) return snapshot;
  const meta = block.payload.meta as
    | {
        header?: InlineNode[][];
        rows?: InlineNode[][][];
        align?: Array<"left" | "center" | "right" | null>;
        headerCellRanges?: Array<{ from: number; to: number } | undefined>;
        rowCellRanges?: Array<Array<{ from: number; to: number } | undefined>>;
      }
    | undefined;
  const header = Array.isArray(meta?.header) ? (meta?.header as InlineNode[][]) : [];
  const rows = Array.isArray(meta?.rows) ? (meta?.rows as InlineNode[][][]) : [];
  const align = Array.isArray(meta?.align) ? (meta?.align ?? []) : [];
  const headerCellRanges = Array.isArray(meta?.headerCellRanges) ? meta.headerCellRanges : [];
  const rowCellRanges = Array.isArray(meta?.rowCellRanges) ? meta.rowCellRanges : [];

  const children: NodeSnapshot[] = [];

  if (header.length > 0) {
    const headerCells = header.map((cellInline, cellIndex) => {
      const cellNode: NodeSnapshot = {
        id: `${block.id}::th:${cellIndex}`,
        type: "table-header-cell",
        props: {
          index: cellIndex,
          align: align[cellIndex] ?? null,
          inline: cloneInlineNodes(cellInline),
          text: inlineNodesToPlainText(cellInline),
        },
        ...(headerCellRanges[cellIndex] ? { range: { ...headerCellRanges[cellIndex]! } } : {}),
        children: [],
      };
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) onNodeCreated?.(cellNode);
      return cellNode;
    });
    const theadNode: NodeSnapshot = {
      id: `${block.id}::thead`,
      type: "table-header",
      props: { columns: header.length },
      children: headerCells,
    };
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) onNodeCreated?.(theadNode);
    children.push(theadNode);
  }

  const bodyChildren = rows.map((rowCells, rowIndex) => {
    const rowChildCells = rowCells.map((cellInline, cellIndex) => {
      const cellNode: NodeSnapshot = {
        id: `${block.id}::td:${rowIndex}:${cellIndex}`,
        type: "table-cell",
        props: {
          rowIndex,
          index: cellIndex,
          align: align[cellIndex] ?? null,
          inline: cloneInlineNodes(cellInline),
          text: inlineNodesToPlainText(cellInline),
        },
        ...(rowCellRanges[rowIndex]?.[cellIndex] ? { range: { ...rowCellRanges[rowIndex][cellIndex]! } } : {}),
        children: [],
      };
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) onNodeCreated?.(cellNode);
      return cellNode;
    });
    const rowNode: NodeSnapshot = {
      id: `${block.id}::row:${rowIndex}`,
      type: "table-row",
      props: { index: rowIndex },
      children: rowChildCells,
    };
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) onNodeCreated?.(rowNode);
    return rowNode;
  });

  if (bodyChildren.length > 0) {
    const tbodyNode: NodeSnapshot = {
      id: `${block.id}::tbody`,
      type: "table-body",
      props: { rows: rows.length },
      children: bodyChildren,
    };
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) onNodeCreated?.(tbodyNode);
    children.push(tbodyNode);
  }

  snapshot.children = children;
  return snapshot;
}

// Boundary-local policy: public fence extraction preserves all content. This
// provisional-only helper is duplicated in worker/React to keep their package APIs unchanged.
function trimProvisionalFenceTail(raw: string): string {
  if (raw.endsWith("\n")) return raw;
  const opening = raw.match(/^ {0,3}(`{3,}|~{3,})[^\n]*\n/);
  if (!opening) return raw;
  const lastNewline = raw.lastIndexOf("\n");
  const tail = raw.slice(lastNewline + 1).match(/^ {0,3}(`+|~+)[\t ]*$/);
  return tail && tail[1][0] === opening[1][0] && tail[1].length < opening[1].length ? raw.slice(0, lastNewline) : raw;
}

function enrichCodeSnapshot(
  block: Block,
  snapshot: NodeSnapshot,
  onNodeCreated?: (node: NodeSnapshot) => void,
): NodeSnapshot {
  const metaCode = typeof block.payload.meta?.code === "string" ? (block.payload.meta?.code as string) : null;
  const source = (metaCode ?? (block.payload.raw ?? "")).replace(/\r\n?/g, "\n");
  // Worker-provided meta.code is already normalized code body (no fences),
  // so preserve its leading indentation verbatim instead of re-running
  // extractCodeLines() heuristics for indented markdown blocks.
  const lines = metaCode !== null ? source.split("\n") : extractCodeLines(block.isFinalized ? source : trimProvisionalFenceTail(source));
  const meta = block.payload.meta as
    | {
        highlightedLines?: HighlightedLine[];
        lang?: string;
        tokenLines?: Array<TokenLineV1 | null>;
        diffKind?: Array<DiffLineKind | null>;
        oldNo?: Array<number | null>;
        newNo?: Array<number | null>;
      }
    | undefined;
  const highlightedHtml = block.payload.highlightedHtml ?? "";
  const metaLines = Array.isArray(meta?.highlightedLines) ? (meta?.highlightedLines as HighlightedLine[]) : null;
  const highlightedLines = metaLines
    ? normalizeHighlightedLines(metaLines, lines.length)
    : extractHighlightedLines(highlightedHtml, lines.length);
  const metaTokenLines = Array.isArray(meta?.tokenLines) ? (meta?.tokenLines as Array<TokenLineV1 | null>) : null;
  const tokenLines = metaTokenLines ? normalizeTokenLines(metaTokenLines, lines.length) : null;
  const metaDiffKind = Array.isArray(meta?.diffKind) ? (meta?.diffKind as Array<DiffLineKind | null>) : null;
  const diffKindLines = metaDiffKind ? normalizeOptionalArray(metaDiffKind, lines.length) : null;
  const metaOldNo = Array.isArray(meta?.oldNo) ? (meta?.oldNo as Array<number | null>) : null;
  const oldNoLines = metaOldNo ? normalizeOptionalArray(metaOldNo, lines.length) : null;
  const metaNewNo = Array.isArray(meta?.newNo) ? (meta?.newNo as Array<number | null>) : null;
  const newNoLines = metaNewNo ? normalizeOptionalArray(metaNewNo, lines.length) : null;
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
  snapshot.children = lines.map((line, index) => {
    const props: Record<string, unknown> = {
      index,
      text: line,
      html: highlightedLines[index] ?? line,
    };
    if (tokenLines) {
      props.tokens = tokenLines[index] ?? null;
    }
    if (diffKindLines) {
      props.diffKind = diffKindLines[index] ?? null;
    }
    if (oldNoLines) {
      props.oldNo = oldNoLines[index] ?? null;
    }
    if (newNoLines) {
      props.newNo = newNoLines[index] ?? null;
    }
    const lineNode: NodeSnapshot = {
      id: `${block.id}::line:${index}`,
      type: "code-line",
      props,
      children: [],
    };
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) onNodeCreated?.(lineNode);
    return lineNode;
  });
  return snapshot;
}

function normalizeTokenLines(lines: Array<TokenLineV1 | null>, fallbackLength: number): Array<TokenLineV1 | null> {
  if (!lines || lines.length === 0) {
    return new Array(Math.max(0, fallbackLength)).fill(null);
  }
  const length = Math.max(fallbackLength, lines.length);
  const result: Array<TokenLineV1 | null> = new Array(length).fill(null);
  for (let i = 0; i < lines.length; i++) {
    result[i] = lines[i] ?? null;
  }
  return result;
}

function normalizeOptionalArray<T>(lines: Array<T | null>, fallbackLength: number): Array<T | null> {
  if (!lines || lines.length === 0) {
    return new Array(Math.max(0, fallbackLength)).fill(null);
  }
  const length = Math.max(fallbackLength, lines.length);
  const result: Array<T | null> = new Array(length).fill(null);
  for (let i = 0; i < lines.length; i++) {
    result[i] = lines[i] ?? null;
  }
  return result;
}

function cloneInlineNodes(nodes: readonly InlineNode[]): InlineNode[] {
  return nodes.map((node) => {
    const sourceRange = node.sourceRange ? { sourceRange: { ...node.sourceRange } } : {};
    if ("children" in node && Array.isArray(node.children)) {
      return { ...node, ...sourceRange, children: cloneInlineNodes(node.children) };
    }
    return { ...node, ...sourceRange };
  });
}

export function inlineNodesToPlainText(nodes: readonly InlineNode[]): string {
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
      case "html":
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
      case "trusted-mdx-inline":
        result += node.raw;
        break;
      case "plugin":
        if (node.children && Array.isArray(node.children)) {
          result += inlineNodesToPlainText(node.children);
        } else {
          result += node.raw;
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

interface SnapshotCodeState {
  readonly source: CodeBlockSourceMetadata;
  readonly configurationRevision: number;
  readonly info: string;
  readonly language?: string;
  readonly lines: CodeLineIndex;
  readonly sourceSnapshot: SourceSnapshot;
  readonly document?: AppendSourceDocument;
  readonly managed: boolean;
}


/**
 * Whether a generic container's cold export carries a `preparedNested` projection, and where. The tree itself is
 * never retained: it is derived from the node's generic children at the cold export boundary.
 */
interface PreparedNestedExportShape {
  readonly block: boolean;
  readonly meta: boolean;
}

interface SnapshotNode {
  id: string;
  type: string;
  parentId: string | null;
  children: string[];
  props: Record<string, unknown>;
  meta?: Record<string, unknown>;
  range?: { from: number; to: number };
  block?: Block;
  preparedNestedExport?: PreparedNestedExportShape;
  codeState?: SnapshotCodeState;
  tableState?: ManagedTableViewState;
  paragraphState?: ManagedParagraphViewState;
}

function isGenericContainerType(type: string): boolean {
  return type === "list" || type === "blockquote" || type === "list-item" || type === "html";
}

/** Drops a producer's prepared tree by shallow copy, so the tree is never cloned into private state. */
function blockWithoutPreparedNested(block: Block): Block {
  const meta = block.payload.meta;
  if (!meta || !Object.prototype.hasOwnProperty.call(meta, "preparedNested")) return block;
  const { preparedNested: _preparedNested, ...rest } = meta;
  return { ...block, payload: { ...block.payload, meta: rest } };
}

function blockWithExactMeta(block: Block, meta: Record<string, unknown> | undefined): Block {
  if (deepEqual(block.payload.meta, meta)) return block;
  const payloadDescriptors = Object.getOwnPropertyDescriptors(block.payload);
  payloadDescriptors.meta = {
    configurable: true,
    enumerable: true,
    writable: true,
    value: meta ? structuredCloneIfPossible(meta) : undefined,
  };
  return { ...block, payload: Object.defineProperties({}, payloadDescriptors) as Block["payload"] };
}

export interface DocumentSnapshot {
  nodes: Map<string, SnapshotNode>;
  rootId: string;
  getBlocks(): Block[];
}

interface MaterializedBlockCache {
  blocks: Block[];
  dirty: boolean;
}

const materializedBlocksBySnapshot = new WeakMap<DocumentSnapshot, MaterializedBlockCache>();
const retiredCodeGenerationsBySnapshot = new WeakMap<DocumentSnapshot, Map<string, number>>();
const retiredTableGenerationsBySnapshot = new WeakMap<DocumentSnapshot, Map<string, number>>();
const retiredParagraphGenerationsBySnapshot = new WeakMap<DocumentSnapshot, Map<string, number>>();
interface CanonicalInputSourceState {
  readonly generation: number;
  readonly document: AppendSourceDocument;
}

const inputSourceBySnapshot = new WeakMap<DocumentSnapshot, CanonicalInputSourceState>();

function inputSourceSnapshot(snapshot: DocumentSnapshot): SourceSnapshot | undefined {
  return inputSourceBySnapshot.get(snapshot)?.document.snapshot();
}

export function createInitialSnapshot(initialBlocks?: Block[]): DocumentSnapshot;
export function createInitialSnapshot(rootSnapshot: NodeSnapshot): DocumentSnapshot;
export function createInitialSnapshot(initial: Block[] | NodeSnapshot = []): DocumentSnapshot {
  let inputSource: CanonicalInputSourceState | undefined;
  if (!Array.isArray(initial) && initial.inputSource !== undefined) {
    const baseline = initial.inputSource;
    if (
      !baseline ||
      !Number.isSafeInteger(baseline.generation) ||
      baseline.generation < 0 ||
      typeof baseline.raw !== "string" ||
      (initial.range !== undefined && (
        initial.range.from !== 0 ||
        initial.range.to !== baseline.raw.length
      ))
    ) throw new TypeError("Initial document input source is invalid");
    const document = new AppendSourceDocument();
    document.append(baseline.raw);
    inputSource = { generation: baseline.generation, document };
  }
  const nodes = new Map<string, SnapshotNode>();
  const root: SnapshotNode = {
    id: PATCH_ROOT_ID,
    type: "__root__",
    parentId: null,
    children: [],
    props: {},
  };
  nodes.set(root.id, root);

  let snapshot: DocumentSnapshot;
  snapshot = {
    nodes,
    rootId: root.id,
    getBlocks: () => materializeBlocks(snapshot),
  };
  if (inputSource) inputSourceBySnapshot.set(snapshot, inputSource);
  retiredCodeGenerationsBySnapshot.set(snapshot, new Map());
  retiredTableGenerationsBySnapshot.set(snapshot, new Map());
  retiredParagraphGenerationsBySnapshot.set(snapshot, new Map());
  materializedBlocksBySnapshot.set(snapshot, { blocks: [], dirty: true });

  if (Array.isArray(initial)) {
    for (const block of initial) {
      const blockSnapshot = createBlockSnapshot(cloneBlock(block));
      insertSnapshotAt(snapshot, root, root.children.length, blockSnapshot);
    }
  } else {
    if (initial.id !== PATCH_ROOT_ID || initial.type !== "__root__" || !Array.isArray(initial.children)) {
      throw new TypeError("Initial document snapshot must be the __root__ node");
    }
    for (const child of initial.children) {
      insertSnapshotAt(snapshot, root, root.children.length, child);
    }
  }
  return snapshot;
}

export function applyPatchBatch(snapshot: DocumentSnapshot, patches: Patch[]): void {
  if (!Array.isArray(patches) || patches.length === 0) return;

  let semanticNodesChanged = false;
  for (const patch of patches) {
    if (patch.op !== "appendInputSource") semanticNodesChanged = true;
    switch (patch.op) {
      case "appendInputSource": {
        const source = inputSourceBySnapshot.get(snapshot);
        if (
          !source ||
          patch.at.blockId !== PATCH_ROOT_ID ||
          patch.at.nodeId !== undefined ||
          patch.at.indexPath !== undefined ||
          !Number.isSafeInteger(patch.generation) ||
          patch.generation !== source.generation ||
          !Number.isSafeInteger(patch.from) ||
          patch.from !== source.document.length ||
          typeof patch.text !== "string"
        ) break;
        source.document.append(patch.text);
        break;
      }
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
        const children = parent.children.slice();
        const childId = children.splice(patch.index, 1)[0];
        parent.children = children;
        if (childId) removeSubtree(snapshot, childId, undefined, undefined, undefined, true);
        break;
      }
      case "replaceChild": {
        const parent = resolveParentNode(snapshot, patch.at);
        if (!parent) break;
        if (patch.index < 0 || patch.index >= parent.children.length) break;
        replaceSnapshotAt(snapshot, parent, patch.index, patch.node);
        break;
      }
      case "setProps": {
        const target = resolveTargetNode(snapshot, patch.at);
        if (!target) break;
        applyPropsToNode(snapshot, target, patch.props);
        break;
      }
      case "setPropsBatch": {
        const entries = Array.isArray(patch.entries) ? (patch.entries as SetPropsBatchEntry[]) : [];
        for (const entry of entries) {
          if (!entry?.at) continue;
          const target = resolveTargetNode(snapshot, entry.at);
          if (!target) continue;
          applyPropsToNode(snapshot, target, entry.props);
        }
        break;
      }
      case "finalize": {
        const target = resolveTargetNode(snapshot, patch.at);
        if (target?.codeState?.managed) {
          target.codeState = {
            ...target.codeState,
            source: { ...target.codeState.source, state: "finalized" },
          };
        }
        if (target?.tableState || target?.paragraphState) break;
        if (target?.block) {
          target.block = cloneBlock(target.block);
          target.block.isFinalized = true;
        }
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
      case "appendCode": {
        const target = resolveTargetNode(snapshot, patch.at);
        if (target) appendCodeState(snapshot, target, patch);
        break;
      }
      case "appendTableRows": {
        const target = resolveTargetNode(snapshot, patch.at);
        if (!target?.tableState || target.type !== "table") break;
        let result: ManagedTablePatchResult;
        try {
          result = appendManagedTableRows(target.tableState, target.id, patch, inputSourceSnapshot(snapshot));
        } catch {
          break;
        }
        if (!("state" in result)) break;
        target.tableState = result.state;
        const finalized = result.state.source.state !== "open";
        if (target.block && target.block.isFinalized !== finalized) {
          target.block = cloneBlock(target.block);
          target.block.isFinalized = finalized;
        }
        break;
      }
      case "updateTableRows": {
        const target = resolveTargetNode(snapshot, patch.at);
        if (!target?.tableState || target.type !== "table") break;
        let result: ManagedTablePatchResult;
        try {
          result = updateManagedTableRows(target.tableState, target.id, patch);
        } catch {
          break;
        }
        if (!("state" in result)) break;
        target.tableState = result.state;
        break;
      }
      case "appendParagraph": {
        const target = resolveTargetNode(snapshot, patch.at);
        if (!target?.paragraphState || target.type !== "paragraph") break;
        let result: ManagedParagraphPatchResult;
        try {
          result = appendManagedParagraphSpans(target.paragraphState, target.id, patch, inputSourceSnapshot(snapshot));
        } catch {
          break;
        }
        if (!("state" in result)) break;
        target.paragraphState = result.state;
        const finalized = result.state.source.state !== "open";
        if (target.block && target.block.isFinalized !== finalized) {
          target.block = cloneBlock(target.block);
          target.block.isFinalized = finalized;
        }
        break;
      }
      case "updateParagraphSpans": {
        const target = resolveTargetNode(snapshot, patch.at);
        if (!target?.paragraphState || target.type !== "paragraph") break;
        let result: ManagedParagraphPatchResult;
        try {
          result = updateManagedParagraphSpans(target.paragraphState, target.id, patch);
        } catch {
          break;
        }
        if (!("state" in result)) break;
        target.paragraphState = result.state;
        break;
      }
      case "decorateCode": {
        const target = resolveTargetNode(snapshot, patch.at);
        if (target) decorateCodeState(target, patch);
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
        applyPropsToNode(snapshot, target, props);
        break;
      }
      default:
        break;
    }
  }

  if (semanticNodesChanged) {
    const cache = materializedBlocksBySnapshot.get(snapshot);
    if (cache) cache.dirty = true;
  }
}

function materializeBlocks(snapshot: DocumentSnapshot): Block[] {
  const cache = materializedBlocksBySnapshot.get(snapshot);
  if (cache && !cache.dirty) return cache.blocks;
  const blocks = buildBlocks(snapshot);
  if (cache) {
    cache.blocks = blocks;
    cache.dirty = false;
  }
  return blocks;
}

function buildBlocks(snapshot: DocumentSnapshot): Block[] {
  const root = snapshot.nodes.get(snapshot.rootId);
  if (!root) return [];
  const source = inputSourceSnapshot(snapshot);
  const result: Block[] = [];
  for (const childId of root.children) {
    const child = snapshot.nodes.get(childId);
    if (!child) continue;
    const block = materializeSnapshotNodeBlock(snapshot, child, source);
    if (block) result.push(block);
  }
  return result;
}

interface LegacyListLayout {
  readonly ordered: boolean;
  readonly loose: boolean;
  readonly start?: number;
}

interface LegacyPreparedProjection {
  readonly prepared: PreparedNestedSnapshot;
  readonly primaryParagraph?: Block;
  readonly primaryInline?: InlineNode[];
}

function legacyListLayout(node: SnapshotNode): LegacyListLayout {
  const blockMeta = node.block?.payload.meta as Record<string, unknown> | undefined;
  const value = (key: "ordered" | "loose" | "start"): unknown => {
    if (Object.prototype.hasOwnProperty.call(node.props, key)) return node.props[key];
    if (node.meta && Object.prototype.hasOwnProperty.call(node.meta, key)) return node.meta[key];
    return blockMeta?.[key];
  };
  const ordered = Boolean(value("ordered"));
  const start = value("start");
  return {
    ordered,
    loose: Boolean(value("loose")),
    start: ordered && typeof start === "number" && start !== 1 ? start : undefined,
  };
}

function primaryListItemChild(snapshot: DocumentSnapshot, parent: SnapshotNode): SnapshotNode | undefined {
  if (parent.type !== "list-item") return undefined;
  for (const childId of parent.children) {
    const child = snapshot.nodes.get(childId);
    if (child?.props.listItemPrimary === true && child.paragraphState) return child;
  }
  return undefined;
}

function managedParagraphLegacyInline(paragraph: ParagraphBlockSnapshot): InlineNode[] {
  const inline: InlineNode[] = [];
  for (const span of paragraph.spans) {
    if (!span.children?.length) {
      inline.push(...cloneInlineNodes(span.nodes));
      continue;
    }
    for (const child of span.children) {
      const props = child.props ?? {};
      if (child.type === "paragraph-text") {
        if (Array.isArray(props.inline)) inline.push(...cloneInlineNodes(props.inline as InlineNode[]));
        else if (typeof props.text === "string") inline.push({ kind: "text", text: props.text });
      } else if (child.type === "paragraph-html" && typeof props.raw === "string") {
        inline.push({
          kind: "html",
          raw: props.raw,
          ...(child.meta?.sanitized === true && typeof props.html === "string" ? { sanitized: props.html } : {}),
        });
      }
    }
  }
  return inline;
}

function materializeLegacyPreparedProjection(
  snapshot: DocumentSnapshot,
  parent: SnapshotNode,
  source: SourceSnapshot | undefined,
  inheritedListLayout?: LegacyListLayout,
): LegacyPreparedProjection {
  const currentListLayout = parent.type === "list" ? legacyListLayout(parent) : inheritedListLayout;
  const listLayout = parent.type === "list-item"
    ? currentListLayout ?? { ordered: false, loose: false }
    : currentListLayout;
  const props = materializeSnapshotNodeProps(parent, source);
  const primary = primaryListItemChild(snapshot, parent);
  let primarySnapshot: NodeSnapshot | undefined;
  let primaryParagraph: Block | undefined;
  let primaryInline: InlineNode[] | undefined;
  if (primary) {
    primarySnapshot = materializeSnapshotNode(snapshot, primary, source, listLayout);
    const candidate = primarySnapshot.props?.block as Block | undefined;
    if (candidate?.type === "paragraph" && primarySnapshot.paragraph) {
      primaryParagraph = candidate;
      primaryInline = managedParagraphLegacyInline(primarySnapshot.paragraph);
    }
  }
  if (parent.type === "list-item" && listLayout) {
    props.ordered = listLayout.ordered;
    props.loose = listLayout.loose;
    props.start = listLayout.start;
  }
  if (primaryParagraph && primaryInline) {
    props.inline = cloneInlineNodes(primaryInline);
    props.text = inlineNodesToPlainText(primaryInline);
  }

  const children: NodeSnapshot[] = [];
  const mixedSegments = primaryParagraph?.payload.meta?.mixedSegments;
  const mixedHtmlTrees = primaryParagraph?.payload.meta?.mixedHtmlTrees as Record<number, HtmlTreeNode[]> | undefined;
  if (Array.isArray(mixedSegments)) {
    for (let index = 0; index < mixedSegments.length; index += 1) {
      const segment = mixedSegments[index];
      if (segment) children.push(createSegmentSnapshot(parent.id, segment, index, "list-item", mixedHtmlTrees?.[index]));
    }
  }
  for (const childId of parent.children) {
    if (primaryParagraph && primary?.id === childId) continue;
    const child = snapshot.nodes.get(childId);
    if (!child) continue;
    if (primaryParagraph && child.id.startsWith(`${parent.id}::list-item:segment:`)) continue;
    const childSnapshot = materializeSnapshotNode(snapshot, child, source, listLayout);
    if (parent.type === "list-item" && child.type === "paragraph") {
      childSnapshot.props = { ...childSnapshot.props, tight: !listLayout?.loose };
    }
    children.push(childSnapshot);
  }
  return { prepared: { props: { ...props }, children }, primaryParagraph, primaryInline };
}

function projectLegacyListItemBlock(block: Block, paragraph: Block, inline: InlineNode[]): Block {
  const meta = { ...(block.payload.meta ?? {}) };
  delete meta.paragraph;
  delete meta.mixedSegments;
  delete meta.mixedHtmlTrees;
  const paragraphMeta = paragraph.payload.meta;
  if (Array.isArray(paragraphMeta?.mixedSegments)) {
    meta.mixedSegments = paragraphMeta.mixedSegments;
    if (paragraphMeta.mixedHtmlTrees !== undefined) meta.mixedHtmlTrees = paragraphMeta.mixedHtmlTrees;
  }
  return {
    ...block,
    payload: {
      ...block.payload,
      inline: cloneInlineNodes(inline),
      meta,
    },
  };
}

function hasManagedPrimaryListChild(snapshot: DocumentSnapshot, list: SnapshotNode): boolean {
  for (const itemId of list.children) {
    const item = snapshot.nodes.get(itemId);
    if (item?.type !== "list-item") continue;
    if (primaryListItemChild(snapshot, item)) return true;
  }
  return false;
}

function materializeSnapshotNodeBlock(
  snapshot: DocumentSnapshot,
  node: SnapshotNode,
  source: SourceSnapshot | undefined,
  prepared?: PreparedNestedSnapshot,
  primaryParagraph?: Block,
  primaryInline?: InlineNode[],
): Block | undefined {
  let block: Block | undefined;
  if (node.paragraphState && node.block) {
    block = materializeManagedParagraphBlock(node.block, node.paragraphState);
  } else if (node.tableState && node.block) {
    block = materializeManagedTableBlock(node.block, node.tableState);
  } else if (node.codeState) {
    block = materializeCodeBlock(node);
  } else if (node.block) {
    block = cloneBlock(node.block);
    const range = node.range;
    if (source && range && isAdmittedAuthoredRange(range, source)) {
      block.payload.raw = source.read(range.from, range.to);
      block.payload.range = { from: range.from, to: range.to };
    }
    const projection = !prepared && !primaryParagraph && (node.type === "list-item" || node.preparedNestedExport?.block)
      ? materializeLegacyPreparedProjection(snapshot, node, source)
      : undefined;
    const itemParagraph = primaryParagraph ?? projection?.primaryParagraph;
    const itemInline = primaryInline ?? projection?.primaryInline;
    if (node.type === "list-item" && itemParagraph && itemInline) {
      block = projectLegacyListItemBlock(block, itemParagraph, itemInline);
    }
    if (node.preparedNestedExport?.block) {
      const nested = prepared ?? projection?.prepared;
      if (nested) {
        const meta: NonNullable<Block["payload"]["meta"]> = {
          ...(block.payload.meta ?? {}),
          preparedNested: nested,
        };
        if (node.type === "list" && hasManagedPrimaryListChild(snapshot, node)) {
          const existingItems = Array.isArray(meta.items) ? meta.items as InlineNode[][] : [];
          meta.items = nested.children
            .filter((child) => child.type === "list-item")
            .map((child, index) => Array.isArray(child.props?.inline)
              ? cloneInlineNodes(child.props.inline as InlineNode[])
              : cloneInlineNodes(existingItems[index] ?? []));
        }
        block.payload.meta = meta;
      }
    }
  }
  return block;
}

function materializedSnapshotNodeRange(node: SnapshotNode): NodeSnapshot["range"] {
  const range = node.paragraphState?.source.sourceRange
    ?? node.tableState?.source.sourceRange
    ?? node.codeState?.source.sourceRange
    ?? node.range;
  return range ? { from: range.from, to: range.to } : undefined;
}

function materializeSnapshotNodeProps(node: SnapshotNode, source: SourceSnapshot | undefined): Record<string, unknown> {
  const props = structuredCloneIfPossible(node.props);
  const range = materializedSnapshotNodeRange(node);
  if (source && range && isAdmittedAuthoredRange(range, source) && typeof props.raw === "string") {
    props.raw = source.read(range.from, range.to);
  }
  return props;
}

function materializeSnapshotNode(
  snapshot: DocumentSnapshot,
  node: SnapshotNode,
  source: SourceSnapshot | undefined,
  inheritedListLayout?: LegacyListLayout,
): NodeSnapshot {
  const projection = materializeLegacyPreparedProjection(snapshot, node, source, inheritedListLayout);
  const children = node.codeState?.managed
    ? [...materializeManagedCodeLineSnapshots(node), ...projection.prepared.children]
    : projection.prepared.children;
  // The exported projection owns its props; the node's props gain `block`, which would make the block's
  // `preparedNested` reach itself if the two shared one object.
  const props = { ...projection.prepared.props };
  const range = materializedSnapshotNodeRange(node);
  const exportShape = node.preparedNestedExport;
  const prepared: PreparedNestedSnapshot | undefined = exportShape
    ? projection.prepared
    : undefined;
  const block = materializeSnapshotNodeBlock(
    snapshot,
    node,
    source,
    prepared,
    projection.primaryParagraph,
    projection.primaryInline,
  );

  if (block) props.block = block;
  const result: NodeSnapshot = { id: node.id, type: node.type, props, children };
  if (node.meta || exportShape?.meta) {
    const meta = node.meta ? structuredCloneIfPossible(node.meta) : {};
    if (exportShape?.meta && prepared) meta.preparedNested = prepared;
    result.meta = meta;
  }
  if (range) result.range = { from: range.from, to: range.to };
  if (node.codeState) {
    result.code = {
      ...copyCodeSource(node.codeState.source),
      configurationRevision: node.codeState.configurationRevision,
      info: node.codeState.info,
      language: node.codeState.language,
      lines: node.codeState.lines.readRange(0, node.codeState.lines.length),
      raw: node.codeState.sourceSnapshot.materialize(),
    };
  }
  if (node.tableState) result.table = materializeManagedTableSnapshot(node.tableState);
  if (node.paragraphState) result.paragraph = materializeManagedParagraphSnapshot(node.paragraphState);
  return result;
}

function copyCodeSource(source: CodeBlockSourceMetadata): CodeBlockSourceMetadata {
  return {
    codeOwnerId: source.codeOwnerId,
    generation: source.generation,
    revision: source.revision,
    state: source.state,
    processedTo: source.processedTo,
    completeLineCount: source.completeLineCount,
    lineCount: source.lineCount,
    sourceRange: { from: source.sourceRange.from, to: source.sourceRange.to },
  };
}

function assertCodeSourceMetadata(source: CodeBlockSourceMetadata, rawLength: number): void {
  const { from, to } = source.sourceRange;
  if (
    typeof source.codeOwnerId !== "string" ||
    source.codeOwnerId.length === 0 ||
    !Number.isSafeInteger(source.generation) ||
    source.generation < 0 ||
    !Number.isSafeInteger(source.revision) ||
    source.revision < 0 ||
    !Number.isSafeInteger(source.processedTo) ||
    source.processedTo < 0 ||
    !Number.isSafeInteger(source.completeLineCount) ||
    source.completeLineCount < 0 ||
    !Number.isSafeInteger(source.lineCount) ||
    source.lineCount < source.completeLineCount ||
    (source.state !== "open" && source.state !== "closed" && source.state !== "finalized") ||
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to < from ||
    to - from !== rawLength
  ) {
    throw new RangeError("Code source metadata is invalid");
  }
}

function createManagedCodeState(
  snapshot: CodeBlockSnapshot,
  ownerId: string,
  canonicalSource?: SourceSnapshot,
): SnapshotCodeState {
  if (
    typeof snapshot.raw !== "string" ||
    snapshot.codeOwnerId !== ownerId ||
    !Number.isSafeInteger(snapshot.configurationRevision) ||
    snapshot.configurationRevision < 0 ||
    typeof snapshot.info !== "string" ||
    (snapshot.language !== undefined && typeof snapshot.language !== "string")
  ) {
    throw new RangeError("Code snapshot owner or configuration is invalid");
  }
  assertCodeSourceMetadata(snapshot, snapshot.raw.length);
  if (!Array.isArray(snapshot.lines)) throw new TypeError("Code snapshot lines must be an array");
  const sourceRange = snapshot.sourceRange;
  const lines = createCodeLineIndex({ lines: snapshot.lines });
  if (lines.length !== snapshot.lineCount || lines.completeLineCount !== snapshot.completeLineCount) {
    throw new RangeError("Code snapshot line counts do not match its records");
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines.get(index);
    if (
      !line ||
      line.index !== index ||
      line.sourceRange.from < sourceRange.from ||
      line.sourceRange.to > sourceRange.to
    ) {
      throw new RangeError("Code snapshot line range is outside its source range");
    }
  }
  let document: AppendSourceDocument | undefined;
  let sourceSnapshot: SourceSnapshot;
  if (canonicalSource) {
    if (sourceRange.to > canonicalSource.length || canonicalSource.read(sourceRange.from, sourceRange.to) !== snapshot.raw) {
      throw new RangeError("Code snapshot source does not match canonical input");
    }
    sourceSnapshot = createSourceWindow(canonicalSource, sourceRange.from, sourceRange.to);
  } else {
    document = new AppendSourceDocument();
    document.append(snapshot.raw);
    sourceSnapshot = createSourceWindow(document.snapshot(), 0, snapshot.raw.length);
  }
  return {
    source: copyCodeSource(snapshot),
    configurationRevision: snapshot.configurationRevision,
    info: snapshot.info,
    language: snapshot.language,
    lines,
    sourceSnapshot,
    document,
    managed: true,
  };
}

function createLegacyCodeState(node: SnapshotNode, nodes: ReadonlyMap<string, SnapshotNode>, snapshot: DocumentSnapshot): SnapshotCodeState {
  const block = node.block;
  if (!block) throw new Error("Legacy code block is missing");
  const raw = block.payload.raw ?? "";
  const fallbackFrom = block.payload.range?.from ?? node.range?.from ?? 0;
  const sourceRange =
    block.payload.range && block.payload.range.to - block.payload.range.from === raw.length
      ? { from: block.payload.range.from, to: block.payload.range.to }
      : { from: fallbackFrom, to: fallbackFrom + raw.length };
  const lineNodes = node.children
    .map((id) => nodes.get(id))
    .filter((line): line is SnapshotNode => Boolean(line))
    .map((line, index) => nodeSnapshotLineRecord(line, index, sourceRange.from));
  const lines = createCodeLineIndex({ lines: lineNodes });
  const canonicalSource = inputSourceSnapshot(snapshot);
  let document: AppendSourceDocument | undefined;
  let sourceSnapshot: SourceSnapshot;
  if (canonicalSource) {
    if (sourceRange.to > canonicalSource.length || canonicalSource.read(sourceRange.from, sourceRange.to) !== raw) {
      throw new RangeError("Legacy code source does not match canonical input");
    }
    sourceSnapshot = createSourceWindow(canonicalSource, sourceRange.from, sourceRange.to);
  } else {
    document = new AppendSourceDocument();
    document.append(raw);
    sourceSnapshot = createSourceWindow(document.snapshot(), 0, raw.length);
  }
  return {
    source: {
      codeOwnerId: node.id,
      generation: 0,
      revision: 0,
      state: block.isFinalized ? "finalized" : "open",
      processedTo: sourceRange.to,
      completeLineCount: lines.completeLineCount,
      lineCount: lines.length,
      sourceRange,
    },
    configurationRevision: 0,
    info: typeof block.payload.meta?.info === "string" ? block.payload.meta.info : "",
    language: typeof block.payload.meta?.lang === "string" ? block.payload.meta.lang : undefined,
    lines,
    sourceSnapshot,
    document,
    managed: false,
  };
}

function nodeSnapshotLineRecord(line: SnapshotNode, index: number, sourceFrom: number): CodeLineRecord {
  return {
    id: line.id,
    index,
    text: typeof line.props.text === "string" ? line.props.text : "",
    ending: "",
    sourceRange: { from: sourceFrom, to: sourceFrom },
    sourceRevision: 0,
    isProvisional: line.props.isProvisional === true,
  };
}

function codeLineTokens(line: CodeLineRecord): TokenLineV1 | undefined {
  const decoration = line.decoration;
  if (!decoration) return undefined;
  return {
    spans: decoration.tokens.spans.map((span) => ({
      t: span.t,
      ...(span.v ? { v: {
        ...(span.v.dark ? { dark: { ...span.v.dark } } : {}),
        ...(span.v.light ? { light: { ...span.v.light } } : {}),
      } } : {}),
      ...(span.s ? { s: { ...span.s } } : {}),
    })),
  };
}

function managedCodeLineProjectionIndex(owner: SnapshotNode, child: NodeSnapshot): number | undefined {
  const state = owner.codeState;
  if (!state?.managed || child.type !== "code-line") return undefined;
  const prefix = `${owner.id}::line:`;
  if (!child.id.startsWith(prefix)) return undefined;
  const index = Number(child.id.slice(prefix.length));
  if (!Number.isSafeInteger(index) || index < 0 || `${prefix}${index}` !== child.id) return undefined;
  return state.lines.get(index) ? index : undefined;
}

function materializeManagedCodeLineSnapshots(owner: SnapshotNode): NodeSnapshot[] {
  const state = owner.codeState;
  if (!state?.managed) return [];
  const children: NodeSnapshot[] = [];
  for (let index = 0; index < state.lines.length; index += 1) {
    const line = state.lines.get(index);
    if (!line) continue;
    const props: Record<string, unknown> = {
      index,
      text: line.text,
      html: line.text,
      isProvisional: line.isProvisional,
    };
    const tokens = codeLineTokens(line);
    if (tokens) props.tokens = tokens;
    if (line.diffKind !== undefined) props.diffKind = line.diffKind;
    if (line.oldNo !== undefined) props.oldNo = line.oldNo;
    if (line.newNo !== undefined) props.newNo = line.newNo;
    children.push({
      id: `${owner.id}::line:${index}`,
      type: "code-line",
      props,
      children: [],
    });
  }
  return children;
}


function appendCodeState(
  snapshot: DocumentSnapshot,
  node: SnapshotNode,
  patch: Extract<Patch, { op: "appendCode" }>,
): void {
  const current = node.codeState;
  if (!current?.managed) return;
  const old = current.source;
  if (
    patch.code.codeOwnerId !== node.id ||
    patch.code.codeOwnerId !== old.codeOwnerId ||
    patch.code.generation !== old.generation ||
    patch.expectedRevision !== old.revision
  ) {
    return;
  }
  if (typeof patch.sourceAppend !== "string" || !Array.isArray(patch.lines)) {
    throw new TypeError("Code append source and line records are invalid");
  }
  if (old.state !== "open" && (
    old.state !== "closed" ||
    patch.code.state !== "finalized" ||
    patch.sourceAppend !== "" ||
    patch.lines.length !== 0 ||
    patch.code.processedTo !== old.processedTo ||
    patch.code.lineCount !== old.lineCount ||
    patch.code.completeLineCount !== old.completeLineCount
  )) return;
  const canonicalSource = inputSourceSnapshot(snapshot);
  const document = current.document;
  const nextLength = patch.code.sourceRange.to - patch.code.sourceRange.from;
  assertCodeSourceMetadata(patch.code, nextLength);
  if (
    !Number.isSafeInteger(patch.expectedRevision) ||
    patch.expectedRevision !== old.revision ||
    !Number.isSafeInteger(patch.fromLine) ||
    patch.fromLine !== old.completeLineCount ||
    patch.code.revision !== old.revision + 1 ||
    patch.code.sourceRange.from !== old.sourceRange.from ||
    patch.code.sourceRange.to !== old.sourceRange.to + patch.sourceAppend.length ||
    patch.code.processedTo < old.processedTo ||
    patch.code.completeLineCount < old.completeLineCount ||
    patch.code.lineCount !== patch.fromLine + patch.lines.length ||
    current.sourceSnapshot.length !== old.sourceRange.to - old.sourceRange.from ||
    (canonicalSource
      ? patch.code.sourceRange.to > canonicalSource.length ||
        canonicalSource.read(old.sourceRange.to, patch.code.sourceRange.to) !== patch.sourceAppend
      : !document || document.length !== current.sourceSnapshot.length)
  ) {
    throw new RangeError("Code append does not match the current semantic frontier");
  }
  const lines = current.lines.replaceTail(patch.fromLine, patch.lines);
  if (lines.length !== patch.code.lineCount || lines.completeLineCount !== patch.code.completeLineCount) {
    throw new RangeError("Code append line records do not match their declared counts");
  }
  for (const line of patch.lines) {
    if (line.sourceRange.from < patch.code.sourceRange.from || line.sourceRange.to > patch.code.sourceRange.to) {
      throw new RangeError("Changed code line range is outside the updated source range");
    }
  }
  if (!canonicalSource && document && patch.sourceAppend.length > 0) document.append(patch.sourceAppend);
  const sourceSnapshot = patch.sourceAppend.length === 0
    ? current.sourceSnapshot
    : canonicalSource
      ? createSourceWindow(canonicalSource, patch.code.sourceRange.from, patch.code.sourceRange.to)
      : createSourceWindow((document as AppendSourceDocument).snapshot(), 0, nextLength);
  node.codeState = {
    ...current,
    source: copyCodeSource(patch.code),
    lines,
    sourceSnapshot,
  };
}

function decorateCodeState(
  node: SnapshotNode,
  patch: Extract<Patch, { op: "decorateCode" }>,
): void {
  const current = node.codeState;
  if (
    !current?.managed ||
    patch.codeOwnerId !== node.id ||
    patch.codeOwnerId !== current.source.codeOwnerId ||
    patch.generation !== current.source.generation ||
    patch.configurationRevision !== current.configurationRevision
  ) {
    return;
  }
  if (!Array.isArray(patch.decorations)) throw new TypeError("Code decorations must be an array");
  const valid: CodeLineDecorationUpdate[] = [];
  for (const decoration of patch.decorations) {
    const line = current.lines.get(decoration.index);
    if (
      line &&
      line.id === decoration.lineId &&
      line.sourceRevision === decoration.sourceRevision &&
      decoration.configurationRevision === current.configurationRevision
    ) {
      valid.push(decoration);
    }
  }
  if (valid.length > 0) {
    const lines = current.lines.decorate(valid);
    if (lines !== current.lines) node.codeState = { ...current, lines };
  }
}

function materializeCodeBlock(node: SnapshotNode): Block {
  const state = node.codeState;
  if (!state) throw new Error("Code state is missing");
  if (!state.managed && node.block) return cloneBlock(node.block);
  const raw = state.sourceSnapshot.materialize();
  const block: Block = node.block
    ? cloneBlock(node.block)
    : {
        id: node.id,
        type: "code",
        isFinalized: state.source.state !== "open",
        payload: { raw },
      };
  block.id = node.id;
  block.type = "code";
  block.isFinalized = state.source.state !== "open";
  block.payload.raw = raw;
  block.payload.range = { ...state.source.sourceRange };
  const meta = { ...(block.payload.meta ?? {}) };
  meta.code = state.lines.materialize().replace(/\r\n?/g, "\n").replace(/\n$/, "");
  meta.info = state.info;
  if (state.language !== undefined) meta.lang = state.language;
  const tokenLines = new Array<TokenLineV1 | null>(state.lines.length).fill(null);
  let hasTokens = false;
  for (let index = 0; index < tokenLines.length; index++) {
    const line = state.lines.get(index);
    const tokens = line ? codeLineTokens(line) : undefined;
    if (!tokens) continue;
    tokenLines[index] = tokens;
    hasTokens = true;
  }
  if (hasTokens) meta.tokenLines = tokenLines;
  block.payload.meta = meta;
  return block;
}
interface ActiveCodeOwnerReplacement {
  readonly id: string;
  readonly generation: number;
  readonly parentId: string;
}

interface ActiveTableOwnerReplacement {
  readonly id: string;
  readonly generation: number;
  readonly parentId: string;
}
interface ActiveParagraphOwnerReplacement {
  readonly id: string;
  readonly generation: number;
  readonly parentId: string;
}


function sameTableCellSourceIdentity(prior: TableCellRecord, next: TableCellRecord): boolean {
  return Boolean(next)
    && prior.id === next.id
    && prior.index === next.index
    && prior.raw === next.raw
    && prior.sourceRange.from === next.sourceRange.from
    && prior.sourceRange.to === next.sourceRange.to;
}

function sameTableHeaderSourceIdentity(prior: TableHeaderRecord, next: TableHeaderRecord): boolean {
  if (
    !next ||
    !Array.isArray(next.cells) ||
    !Array.isArray(next.align) ||
    prior.sourceRange.from !== next.sourceRange.from ||
    prior.sourceRange.to !== next.sourceRange.to ||
    prior.cells.length !== next.cells.length ||
    prior.align.length !== next.align.length ||
    prior.align.some((align, index) => align !== next.align[index])
  ) return false;
  for (let index = 0; index < prior.cells.length; index += 1) {
    const previousCell = prior.cells[index];
    const nextCell = next.cells[index];
    if (!previousCell || !nextCell || !sameTableCellSourceIdentity(previousCell, nextCell)) return false;
  }
  return true;
}

function sameTableRowSourceIdentity(prior: TableRowRecord, next: TableRowRecord): boolean {
  if (
    !next ||
    prior.id !== next.id ||
    prior.index !== next.index ||
    prior.sourceRevision !== next.sourceRevision ||
    prior.isProvisional !== next.isProvisional ||
    prior.sourceRange.from !== next.sourceRange.from ||
    prior.sourceRange.to !== next.sourceRange.to ||
    prior.cells.length !== next.cells.length
  ) return false;
  for (let index = 0; index < prior.cells.length; index += 1) {
    const previousCell = prior.cells[index];
    const nextCell = next.cells[index];
    if (!previousCell || !nextCell || !sameTableCellSourceIdentity(previousCell, nextCell)) return false;
  }
  return true;
}

function sameCompletedTableRowSources(
  current: ManagedTableViewState,
  nextRows: readonly TableRowRecord[],
): boolean {
  if (nextRows.length < current.source.completeRowCount) return false;
  for (let index = 0; index < current.source.completeRowCount; index += 1) {
    const previousRow = current.rows.get(index);
    const nextRow = nextRows[index];
    if (!previousRow || !nextRow || !sameTableRowSourceIdentity(previousRow, nextRow)) return false;
  }
  return true;
}

function sameParagraphSpanSourceIdentity(prior: ParagraphSpanRecord, next: ParagraphSpanRecord | undefined): boolean {
  if (!next?.sourceRange) return false;
  return prior.id === next.id
    && prior.index === next.index
    && prior.sourceRevision === next.sourceRevision
    && prior.isProvisional === next.isProvisional
    && prior.sourceRange.from === next.sourceRange.from
    && prior.sourceRange.to === next.sourceRange.to;
}
function sameCompletedParagraphSourceBytes(
  current: ManagedParagraphViewState,
  next: ParagraphBlockSnapshot,
): boolean {
  if (typeof next.raw !== "string") return false;
  const source = current.source;
  const provisional = source.spanCount > source.completeSpanCount
    ? current.spans.get(source.completeSpanCount)
    : undefined;
  if (source.spanCount > source.completeSpanCount && !provisional) return false;
  const completedLength = (provisional?.sourceRange.from ?? source.sourceRange.to) - source.sourceRange.from;
  if (!Number.isSafeInteger(completedLength) || completedLength < 0 || next.raw.length < completedLength) return false;
  for (let from = 0; from < completedLength; from += 4096) {
    const to = Math.min(completedLength, from + 4096);
    const retained = current.sourceSnapshot.read(from, to);
    if (retained.length !== to - from) return false;
    for (let offset = 0; offset < retained.length; offset += 1) {
      if (retained.charCodeAt(offset) !== next.raw.charCodeAt(from + offset)) return false;
    }
  }
  return true;
}


function sameCompletedParagraphSpanSources(
  current: ManagedParagraphViewState,
  next: ParagraphBlockSnapshot,
): boolean {
  const completeSpanCount = current.source.completeSpanCount;
  if (
    !Array.isArray(next.spans) ||
    next.completeSpanCount < completeSpanCount ||
    next.spans.length < completeSpanCount
  ) return false;
  for (let index = 0; index < completeSpanCount; index += 1) {
    const prior = current.spans.get(index);
    const replacement = next.spans[index];
    if (!prior || !replacement || !sameParagraphSpanSourceIdentity(prior, replacement)) return false;
  }
  return sameCompletedParagraphSourceBytes(current, next);
}


type AuthoredSourceRange = NonNullable<NodeSnapshot["range"]>;

function isAuthoredSourceRange(value: unknown): value is AuthoredSourceRange {
  if (!value || typeof value !== "object" || !("from" in value) || !("to" in value)) return false;
  const { from, to } = value;
  return typeof from === "number" &&
    typeof to === "number" &&
    Number.isSafeInteger(from) &&
    Number.isSafeInteger(to) &&
    from >= 0 &&
    to >= from;
}

function isAdmittedAuthoredRange(
  value: unknown,
  source: SourceSnapshot | undefined,
): value is AuthoredSourceRange {
  return isAuthoredSourceRange(value) && (!source || value.to <= source.length);
}

function snapshotNodeRange(node: NodeSnapshot): unknown {
  if (node.range !== undefined) return node.range;
  const block = node.props?.block;
  if (!block || typeof block !== "object" || !("payload" in block)) return undefined;
  const payload = block.payload;
  if (!payload || typeof payload !== "object" || !("range" in payload)) return undefined;
  return payload.range;
}


function canInsertSnapshot(
  snapshot: DocumentSnapshot,
  root: NodeSnapshot,
  activeCodeReplacement?: ActiveCodeOwnerReplacement,
  activeTableReplacement?: ActiveTableOwnerReplacement,
  activeParagraphReplacement?: ActiveParagraphOwnerReplacement,
): boolean {
  const retired = retiredCodeGenerationsBySnapshot.get(snapshot);
  const retiredTables = retiredTableGenerationsBySnapshot.get(snapshot);
  const retiredParagraphs = retiredParagraphGenerationsBySnapshot.get(snapshot);
  const canonicalSource = inputSourceSnapshot(snapshot);
  const visit = (candidate: NodeSnapshot, isRoot: boolean): boolean => {
    const range = snapshotNodeRange(candidate);
    if (range !== undefined && !isAdmittedAuthoredRange(range, canonicalSource)) return false;
    if (candidate.code) {
      if (candidate.code.codeOwnerId !== candidate.id || !Number.isSafeInteger(candidate.code.generation) || candidate.code.generation < 0) {
        return false;
      }
      const current = snapshot.nodes.get(candidate.id);
      const currentCode = current?.codeState?.managed ? current.codeState.source : undefined;
      const currentGeneration = currentCode?.generation ?? -1;
      const retiredGeneration = retired?.get(candidate.id) ?? -1;
      const isActiveReplacement = isRoot
        && activeCodeReplacement !== undefined
        && activeCodeReplacement.id === candidate.id
        && activeCodeReplacement.generation === candidate.code.generation
        && current?.parentId === activeCodeReplacement.parentId
        && currentCode !== undefined
        && currentGeneration === candidate.code.generation
        && candidate.code.revision >= currentCode.revision
        && candidate.code.processedTo >= currentCode.processedTo
        && candidate.code.completeLineCount >= currentCode.completeLineCount
        && candidate.code.sourceRange.from === currentCode.sourceRange.from
        && candidate.code.sourceRange.to >= currentCode.sourceRange.to
        && retiredGeneration < candidate.code.generation;
      if (candidate.code.generation <= Math.max(currentGeneration, retiredGeneration) && !isActiveReplacement) return false;
    }
    if (candidate.table) {
      if (
        candidate.type !== "table" ||
        candidate.table.tableOwnerId !== candidate.id ||
        !Number.isSafeInteger(candidate.table.generation) ||
        candidate.table.generation < 0 ||
        (candidate.children?.length ?? 0) > 0
      ) return false;
      const current = snapshot.nodes.get(candidate.id);
      const currentTable = current?.tableState;
      const currentSource = currentTable?.source;
      const currentGeneration = currentSource?.generation ?? -1;
      const retiredGeneration = retiredTables?.get(candidate.id) ?? -1;
      const isActiveReplacement = isRoot
        && activeTableReplacement !== undefined
        && activeTableReplacement.id === candidate.id
        && activeTableReplacement.generation === candidate.table.generation
        && current?.parentId === activeTableReplacement.parentId
        && currentTable !== undefined
        && currentSource !== undefined
        && currentGeneration === candidate.table.generation
        && candidate.table.revision >= currentSource.revision
        && candidate.table.processedTo >= currentSource.processedTo
        && candidate.table.completeRowCount >= currentSource.completeRowCount
        && candidate.table.sourceRange.from === currentSource.sourceRange.from
        && candidate.table.sourceRange.to >= currentSource.sourceRange.to
        && sameTableHeaderSourceIdentity(currentTable.header, candidate.table.header)
        && sameCompletedTableRowSources(currentTable, candidate.table.rows)
        && retiredGeneration < candidate.table.generation;
      if (candidate.table.generation <= Math.max(currentGeneration, retiredGeneration) && !isActiveReplacement) return false;
    }
    if (candidate.paragraph) {
      const paragraph = candidate.paragraph;
      if (
        candidate.type !== "paragraph" ||
        paragraph.paragraphOwnerId !== candidate.id ||
        !Number.isSafeInteger(paragraph.generation) ||
        paragraph.generation < 0 ||
        !Number.isSafeInteger(paragraph.revision) ||
        paragraph.revision < 0 ||
        !Number.isSafeInteger(paragraph.processedTo) ||
        paragraph.processedTo < 0 ||
        !Number.isSafeInteger(paragraph.completeSpanCount) ||
        paragraph.completeSpanCount < 0 ||
        !Number.isSafeInteger(paragraph.spanCount) ||
        paragraph.spanCount < paragraph.completeSpanCount ||
        !Array.isArray(paragraph.spans) ||
        paragraph.spanCount !== paragraph.spans.length ||
        (paragraph.state !== "open" && paragraph.state !== "closed" && paragraph.state !== "finalized") ||
        (paragraph.state !== "open" && paragraph.spanCount !== paragraph.completeSpanCount) ||
        typeof paragraph.raw !== "string" ||
        !paragraph.sourceRange ||
        !Number.isSafeInteger(paragraph.sourceRange.from) ||
        !Number.isSafeInteger(paragraph.sourceRange.to) ||
        paragraph.sourceRange.from < 0 ||
        paragraph.sourceRange.to < paragraph.sourceRange.from ||
        paragraph.sourceRange.to - paragraph.sourceRange.from !== paragraph.raw.length ||
        (candidate.children?.length ?? 0) > 0
      ) return false;
      const current = snapshot.nodes.get(candidate.id);
      const currentParagraph = current?.paragraphState;
      const currentSource = currentParagraph?.source;
      const currentGeneration = currentSource?.generation ?? -1;
      const retiredGeneration = retiredParagraphs?.get(candidate.id) ?? -1;
      const isActiveReplacement = isRoot
        && activeParagraphReplacement !== undefined
        && activeParagraphReplacement.id === candidate.id
        && activeParagraphReplacement.generation === paragraph.generation
        && current?.parentId === activeParagraphReplacement.parentId
        && currentParagraph !== undefined
        && currentSource !== undefined
        && currentGeneration === paragraph.generation
        && paragraph.revision >= currentSource.revision
        && paragraph.processedTo >= currentSource.processedTo
        && paragraph.completeSpanCount >= currentSource.completeSpanCount
        && paragraph.spanCount >= currentSource.spanCount
        && paragraph.sourceRange.from === currentSource.sourceRange.from
        && paragraph.sourceRange.to >= currentSource.sourceRange.to
        && (currentSource.state !== "closed" || paragraph.state !== "open")
        && (currentSource.state !== "finalized" || (
          paragraph.state === "finalized"
          && paragraph.sourceRange.to === currentSource.sourceRange.to
          && paragraph.spanCount === currentSource.spanCount
        ))
        && sameCompletedParagraphSpanSources(currentParagraph, paragraph)
        && retiredGeneration < paragraph.generation;
      if (paragraph.generation <= Math.max(currentGeneration, retiredGeneration) && !isActiveReplacement) return false;
    }
    return !candidate.children || candidate.children.every((child) => visit(child, false));
  };
  return visit(root, true);
}

function prepareSnapshotNode(
  snapshot: DocumentSnapshot,
  parent: SnapshotNode,
  nodeSnapshot: NodeSnapshot,
  activeCodeReplacement?: ActiveCodeOwnerReplacement,
  activeTableReplacement?: ActiveTableOwnerReplacement,
  activeParagraphReplacement?: ActiveParagraphOwnerReplacement,
): { node: SnapshotNode; nodes: Map<string, SnapshotNode> } | null {
  if (!parent || !canInsertSnapshot(snapshot, nodeSnapshot, activeCodeReplacement, activeTableReplacement, activeParagraphReplacement)) return null;
  const nodes = new Map<string, SnapshotNode>();
  const node = buildNodeFromSnapshot(snapshot, nodeSnapshot, parent.id, nodes);
  return node ? { node, nodes } : null;
}

function commitSnapshotNode(
  snapshot: DocumentSnapshot,
  parent: SnapshotNode,
  index: number,
  prepared: { node: SnapshotNode; nodes: Map<string, SnapshotNode> },
): SnapshotNode {
  removeSubtree(snapshot, prepared.node.id);
  for (const [id, node] of prepared.nodes) snapshot.nodes.set(id, node);
  const clamped = clamp(index, 0, parent.children.length);
  if (clamped === parent.children.length) {
    parent.children.push(prepared.node.id);
  } else {
    const children = parent.children.slice();
    children.splice(clamped, 0, prepared.node.id);
    parent.children = children;
  }
  return prepared.node;
}

function insertSnapshotAt(snapshot: DocumentSnapshot, parent: SnapshotNode, index: number, nodeSnapshot: NodeSnapshot): SnapshotNode | null {
  const prepared = prepareSnapshotNode(snapshot, parent, nodeSnapshot);
  return prepared ? commitSnapshotNode(snapshot, parent, index, prepared) : null;
}

function replaceSnapshotAt(snapshot: DocumentSnapshot, parent: SnapshotNode, index: number, nodeSnapshot: NodeSnapshot): SnapshotNode | null {
  const replacedId = parent.children[index];
  const replacedNode = replacedId ? snapshot.nodes.get(replacedId) : undefined;
  const activeCodeReplacement = replacedId === nodeSnapshot.id
    && nodeSnapshot.code
    && replacedNode?.parentId === parent.id
    && replacedNode.codeState?.managed
    && replacedNode.codeState.source.generation === nodeSnapshot.code.generation
    ? { id: replacedId, generation: nodeSnapshot.code.generation, parentId: parent.id }
    : undefined;
  const activeTableReplacement = replacedId === nodeSnapshot.id
    && nodeSnapshot.table
    && replacedNode?.parentId === parent.id
    && replacedNode.tableState?.source.generation === nodeSnapshot.table.generation
    ? { id: replacedId, generation: nodeSnapshot.table.generation, parentId: parent.id }
    : undefined;
  const activeParagraphReplacement = replacedId === nodeSnapshot.id
    && nodeSnapshot.paragraph
    && replacedNode?.parentId === parent.id
    && replacedNode.paragraphState?.source.generation === nodeSnapshot.paragraph.generation
    ? { id: replacedId, generation: nodeSnapshot.paragraph.generation, parentId: parent.id }
    : undefined;
  const prepared = prepareSnapshotNode(snapshot, parent, nodeSnapshot, activeCodeReplacement, activeTableReplacement, activeParagraphReplacement);
  if (!prepared) return null;
  if (replacedId) removeSubtree(snapshot, replacedId, activeCodeReplacement, activeTableReplacement, activeParagraphReplacement);
  if (prepared.node.id !== replacedId) removeSubtree(snapshot, prepared.node.id);
  for (const [id, node] of prepared.nodes) snapshot.nodes.set(id, node);
  const clamped = clamp(index, 0, parent.children.length);
  parent.children.splice(clamped, 0, prepared.node.id);
  return prepared.node;
}


function buildNodeFromSnapshot(
  snapshot: DocumentSnapshot,
  snapshotNode: NodeSnapshot,
  parentId: string | null,
  targetNodes: Map<string, SnapshotNode>,
): SnapshotNode | null {
  if (!snapshotNode || !snapshotNode.id) return null;
  if (snapshotNode.inputSource !== undefined) {
    throw new TypeError("Input source baseline is only valid on the document root");
  }
  if (snapshotNode.code && snapshotNode.type !== "code") {
    throw new TypeError("Code source metadata is only valid on code nodes");
  }
  if (snapshotNode.table && snapshotNode.type !== "table") {
    throw new TypeError("Table source metadata is only valid on table nodes");
  }
  if (snapshotNode.table && (snapshotNode.children?.length ?? 0) > 0) {
    throw new TypeError("Managed table snapshots cannot carry a synthetic child tree");
  }
  if (snapshotNode.paragraph && snapshotNode.type !== "paragraph") {
    throw new TypeError("Paragraph source metadata is only valid on paragraph nodes");
  }
  if (snapshotNode.paragraph && (snapshotNode.children?.length ?? 0) > 0) {
    throw new TypeError("Managed paragraph snapshots cannot carry a synthetic child tree");
  }
  const props = { ...(snapshotNode.props ?? {}) };
  const genericContainer = isGenericContainerType(snapshotNode.type);
  let block: Block | undefined;
  let blockExportsPreparedNested = false;
  if (props.block && typeof props.block === "object") {
    const incoming = props.block as Block;
    blockExportsPreparedNested = genericContainer && incoming.payload.meta?.preparedNested !== undefined;
    block = cloneBlock(genericContainer ? blockWithoutPreparedNested(incoming) : incoming);
    delete props.block;
  }
  let admittedMeta = snapshotNode.meta;
  const metaExportsPreparedNested = genericContainer && admittedMeta?.preparedNested !== undefined;
  if (metaExportsPreparedNested && admittedMeta) {
    const { preparedNested: _preparedNested, ...rest } = admittedMeta;
    admittedMeta = rest;
  }
  const canonicalSource = inputSourceSnapshot(snapshot);
  const tableState = snapshotNode.table
    ? createManagedTableState(snapshotNode.table, snapshotNode.id, undefined, canonicalSource)
    : undefined;
  const paragraphState = snapshotNode.paragraph
    ? createManagedParagraphState(snapshotNode.paragraph, snapshotNode.id, undefined, canonicalSource)
    : undefined;
  if (!block && tableState) {
    block = {
      id: snapshotNode.id,
      type: "table",
      isFinalized: tableState.source.state !== "open",
      payload: { raw: "", range: { ...tableState.source.sourceRange }, meta: {} },
    };
  }
  if (tableState && block) block.isFinalized = tableState.source.state !== "open";
  if (!block && paragraphState) {
    block = {
      id: snapshotNode.id,
      type: "paragraph",
      isFinalized: paragraphState.source.state !== "open",
      payload: { raw: "", inline: [], range: { ...paragraphState.source.sourceRange }, meta: {} },
    };
  }
  if (paragraphState && block) block.isFinalized = paragraphState.source.state !== "open";
  const managedSourceNode =
    Boolean(snapshotNode.code || snapshotNode.table || snapshotNode.paragraph) ||
    isManagedSourceFamily(snapshotNode.type);
  const range = snapshotNode.range
    ? { ...snapshotNode.range }
    : managedSourceNode && block?.payload.range
      ? { ...block.payload.range }
      : undefined;
  if (block && !managedSourceNode) {
    block.payload.range = range ? { ...range } : undefined;
    block = blockWithExactMeta(block, admittedMeta ? structuredCloneIfPossible(admittedMeta) : undefined);
  }
  const node: SnapshotNode = {
    id: snapshotNode.id,
    type: snapshotNode.type,
    parentId,
    props,
    children: [],
    meta: admittedMeta ? structuredCloneIfPossible(admittedMeta) : undefined,
    range,
    block,
    preparedNestedExport: blockExportsPreparedNested || metaExportsPreparedNested
      ? { block: blockExportsPreparedNested, meta: metaExportsPreparedNested }
      : undefined,
    tableState,
    paragraphState,
  };
  targetNodes.set(node.id, node);
  if (snapshotNode.code) {
    node.codeState = createManagedCodeState(snapshotNode.code, node.id, canonicalSource);
  }
  if (!tableState && !paragraphState) {
    if (snapshotNode.children) {
      for (const child of snapshotNode.children) {
        if (managedCodeLineProjectionIndex(node, child) !== undefined) continue;
        const built = buildNodeFromSnapshot(snapshot, child, node.id, targetNodes);
        if (built) node.children.push(built.id);
      }
    }
    if (node.type === "code" && node.block && !node.codeState) {
      node.codeState = createLegacyCodeState(node, targetNodes, snapshot);
    }
  }
  return node;
}

function removeSubtree(
  snapshot: DocumentSnapshot,
  nodeId: string,
  activeCodeReplacement?: ActiveCodeOwnerReplacement,
  activeTableReplacement?: ActiveTableOwnerReplacement,
  activeParagraphReplacement?: ActiveParagraphOwnerReplacement,
  skipParentUnlink = false,
){
  const node = snapshot.nodes.get(nodeId);
  if (!node) return;
  if (node.codeState?.managed) {
    const generation = node.codeState.source.generation;
    const isPreservedActiveOwner = activeCodeReplacement !== undefined
      && node.id === activeCodeReplacement.id
      && node.parentId === activeCodeReplacement.parentId
      && generation === activeCodeReplacement.generation;
    if (!isPreservedActiveOwner) {
      const retired = retiredCodeGenerationsBySnapshot.get(snapshot);
      if (retired) retired.set(node.id, Math.max(retired.get(node.id) ?? -1, generation));
    }
  }
  if (node.tableState) {
    const generation = node.tableState.source.generation;
    const isPreservedActiveOwner = activeTableReplacement !== undefined
      && node.id === activeTableReplacement.id
      && node.parentId === activeTableReplacement.parentId
      && generation === activeTableReplacement.generation;
    if (!isPreservedActiveOwner) {
      const retired = retiredTableGenerationsBySnapshot.get(snapshot);
      if (retired) retired.set(node.id, Math.max(retired.get(node.id) ?? -1, generation));
    }
  }
  if (node.paragraphState) {
    const generation = node.paragraphState.source.generation;
    const isPreservedActiveOwner = activeParagraphReplacement !== undefined
      && node.id === activeParagraphReplacement.id
      && node.parentId === activeParagraphReplacement.parentId
      && generation === activeParagraphReplacement.generation;
    if (!isPreservedActiveOwner) {
      const retired = retiredParagraphGenerationsBySnapshot.get(snapshot);
      if (retired) retired.set(node.id, Math.max(retired.get(node.id) ?? -1, generation));
    }
  }
  for (const childId of node.children) {
    removeSubtree(snapshot, childId, activeCodeReplacement, activeTableReplacement, activeParagraphReplacement);
  }
  snapshot.nodes.delete(node.id);
  if (node.parentId && !skipParentUnlink) {
    const parent = snapshot.nodes.get(node.parentId);
    if (parent) {
      const children = parent.children.filter((id) => id !== node.id);
      if (children.length !== parent.children.length) parent.children = children;
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

function isManagedSourceFamily(type: string): boolean {
  return type === "code" ||
    type.startsWith("code-") ||
    type === "table" ||
    type.startsWith("table-") ||
    type.startsWith("paragraph-");
}

function hasManagedSourceOwner(snapshot: DocumentSnapshot, node: SnapshotNode): boolean {
  let sourceOwner: SnapshotNode | undefined = node;
  while (sourceOwner) {
    if (
      sourceOwner.codeState ||
      sourceOwner.tableState ||
      sourceOwner.paragraphState ||
      isManagedSourceFamily(sourceOwner.type)
    ) return true;
    sourceOwner = sourceOwner.parentId ? snapshot.nodes.get(sourceOwner.parentId) : undefined;
  }
  return false;
}

function supportsGenericSourceRangeTarget(snapshot: DocumentSnapshot, node: SnapshotNode): boolean {
  if (hasManagedSourceOwner(snapshot, node)) return false;
  switch (node.type) {
    case "paragraph":
    case "list":
    case "blockquote":
    case "list-item":
    case "list-item-text":
    case "list-item-html":
    case "list-item-mdx":
      return true;
    default:
      return node.type !== "__root__";
  }
}

function applyPropsToNode(snapshot: DocumentSnapshot, node: SnapshotNode, props: Record<string, unknown> | undefined) {
  if (!props) return;
  const hasRange = Object.prototype.hasOwnProperty.call(props, "range");
  const hasMeta = Object.prototype.hasOwnProperty.call(props, "meta");
  let range: { from: number; to: number } | undefined;
  if (hasRange) {
    const candidate = props.range;
    const source = inputSourceSnapshot(snapshot);
    if (
      !source ||
      !supportsGenericSourceRangeTarget(snapshot, node) ||
      !isAdmittedAuthoredRange(candidate, source)
    ) return;
    range = { from: candidate.from, to: candidate.to };
  }

  let applyMetaUpdate = false;
  let nextMeta: Record<string, unknown> | undefined;
  const metadataType =
    props?.block && typeof props.block === "object" && typeof (props.block as Block).type === "string"
      ? (props.block as Block).type
      : node.type;
  if (hasMeta && !hasManagedSourceOwner(snapshot, node) && !isManagedSourceFamily(metadataType)) {
    const candidate = props.meta;
    if (candidate === null) {
      applyMetaUpdate = true;
    } else if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
      nextMeta = { ...(candidate as Record<string, unknown>) };
      if (isGenericContainerType(metadataType)) delete nextMeta.preparedNested;
      applyMetaUpdate = true;
    }
  }

  const next = { ...node.props };
  if (hasMeta) delete next.meta;
  for (const [key, value] of Object.entries(props)) {
    if (key === "range" || key === "meta") continue;
    if (key === "block" && value && typeof value === "object") {
      const incoming = value as Block;
      if (isGenericContainerType(node.type)) {
        const blockExports = incoming.payload.meta?.preparedNested !== undefined;
        const metaExports = node.preparedNestedExport?.meta === true;
        node.preparedNestedExport = blockExports || metaExports ? { block: blockExports, meta: metaExports } : undefined;
        node.block = cloneBlock(blockWithoutPreparedNested(incoming));
      } else {
        node.block = cloneBlock(incoming);
      }
      if (node.range) node.block.payload.range = { ...node.range };
      continue;
    }
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  if (range) {
    node.range = range;
    if (node.block) node.block.payload.range = { ...range };
  }
  if (applyMetaUpdate) {
    node.meta = nextMeta ? structuredCloneIfPossible(nextMeta) : undefined;
    if (node.block) node.block = blockWithExactMeta(node.block, node.meta);
  }
  node.props = next;
}



function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
