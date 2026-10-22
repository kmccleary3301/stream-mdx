declare const __STREAM_MDX_COUNTERS__: boolean;

import { parser as baseMdParser, GFM } from "@lezer/markdown";
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
import type {
  Block,
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

export function createBlockSnapshot(block: Block): NodeSnapshot;
export function createBlockSnapshot(
  block: Block,
  onNodeCreated?: (node: NodeSnapshot) => void,
): NodeSnapshot {
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
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    onNodeCreated?.(base);
  }

  switch (block.type) {
    case "paragraph":
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
      const segNode = createSegmentSnapshot(block.id, segment, index, "paragraph", meta?.mixedHtmlTrees?.[index]);
      onNodeCreated(segNode);
      return segNode;
    });
  } else {
    snapshot.children = segments.map((segment, index) => createSegmentSnapshot(block.id, segment, index, "paragraph", meta?.mixedHtmlTrees?.[index]));
  }
  return snapshot;
}


function createSegmentSnapshot(
  parentId: string,
  segment: MixedContentSegment,
  index: number,
  parentType: "paragraph" | "blockquote" | "list-item",
  htmlTree?: HtmlTreeNode[],
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
        children: [],
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
      html: highlightedLines[index] ?? null,
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

function cloneInlineNodes(nodes: InlineNode[]): InlineNode[] {
  return nodes.map((node) => {
    const sourceRange = node.sourceRange ? { sourceRange: { ...node.sourceRange } } : {};
    if ("children" in node && Array.isArray(node.children)) {
      return { ...node, ...sourceRange, children: cloneInlineNodes(node.children) };
    }
    return { ...node, ...sourceRange };
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
        appendLinesToCodeNode(
          snapshot,
          parent,
          patch.startIndex,
          patch.lines ?? [],
          patch.highlight ?? [],
          patch.tokens,
          patch.diffKind,
          patch.oldNo,
          patch.newNo,
        );
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
  tokens?: Array<TokenLineV1 | null>,
  diffKind?: Array<DiffLineKind | null>,
  oldNo?: Array<number | null>,
  newNo?: Array<number | null>,
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
    if (tokens && Object.prototype.hasOwnProperty.call(tokens, i)) {
      child.props.tokens = tokens[i] ?? null;
    }
    if (diffKind && Object.prototype.hasOwnProperty.call(diffKind, i)) {
      child.props.diffKind = diffKind[i] ?? null;
    }
    if (oldNo && Object.prototype.hasOwnProperty.call(oldNo, i)) {
      child.props.oldNo = oldNo[i] ?? null;
    }
    if (newNo && Object.prototype.hasOwnProperty.call(newNo, i)) {
      child.props.newNo = newNo[i] ?? null;
    }
    snapshot.nodes.set(child.id, child);
    parent.children.splice(currentIndex, 0, child.id);
    currentIndex++;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
