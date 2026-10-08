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
  DiffKind,
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
      return enrichContainerSnapshot(block, base);
    case "list":
      return enrichContainerSnapshot(block, base);
    case "list-item":
      if (block.payload.meta?.preparedNested) return enrichContainerSnapshot(block, base);
      return base;
    case "table":
      return enrichTableSnapshot(block, base);
    case "code":
      return enrichCodeSnapshot(block, base);
    default:
      return base;
  }
}

function enrichContainerSnapshot(block: Block, snapshot: NodeSnapshot): NodeSnapshot {
  const prepared = block.payload.meta?.preparedNested as PreparedNestedSnapshot | undefined;
  const nested = prepared ?? prepareNestedBlockSnapshot(block, new InlineParser(), baseMdParser.configure([GFM, createBlockCompatibilityExtension()]));
  snapshot.props = { ...snapshot.props, ...structuredCloneIfPossible(nested.props) };
  snapshot.children = structuredCloneIfPossible(nested.children);
  return snapshot;
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

  if (bodyChildren.length > 0) {
    children.push({
      id: `${block.id}::tbody`,
      type: "table-body",
      props: { rows: rows.length },
      children: bodyChildren,
    });
  }

  snapshot.children = children;
  return snapshot;
}

function enrichCodeSnapshot(block: Block, snapshot: NodeSnapshot): NodeSnapshot {
  const metaCode = typeof block.payload.meta?.code === "string" ? (block.payload.meta?.code as string) : null;
  const source = metaCode ?? (block.payload.raw ?? "");
  // Worker-provided meta.code is already normalized code body (no fences),
  // so preserve its leading indentation verbatim instead of re-running
  // extractCodeLines() heuristics for indented markdown blocks.
  const lines = metaCode !== null ? source.replace(/\r\n?/g, "\n").split("\n") : extractCodeLines(source);
  const meta = block.payload.meta as
    | {
        highlightedLines?: HighlightedLine[];
        lang?: string;
        tokenLines?: Array<TokenLineV1 | null>;
        diffKind?: Array<DiffKind | null>;
        oldNo?: Array<number | null>;
        newNo?: Array<number | null>;
      }
    | undefined;
  const highlightedHtml = block.payload.highlightedHtml ?? "";
  const hasBlockHighlight = typeof block.payload.highlightedHtml === "string" && block.payload.highlightedHtml.length > 0;
  const metaLines = Array.isArray(meta?.highlightedLines) ? (meta?.highlightedLines as HighlightedLine[]) : null;
  const includeLineHtml = metaLines ? true : !hasBlockHighlight || lines.length >= 200;
  const highlightedLines = metaLines
    ? normalizeHighlightedLines(metaLines, lines.length)
    : extractHighlightedLines(highlightedHtml, lines.length);
  const metaTokenLines = Array.isArray(meta?.tokenLines) ? (meta?.tokenLines as Array<TokenLineV1 | null>) : null;
  const tokenLines = metaTokenLines ? normalizeTokenLines(metaTokenLines, lines.length) : null;
  const metaDiffKind = Array.isArray(meta?.diffKind) ? (meta?.diffKind as Array<DiffKind | null>) : null;
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
      html: includeLineHtml ? (highlightedLines[index] ?? null) : null,
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
    return {
      id: `${block.id}::line:${index}`,
      type: "code-line",
      props,
      children: [],
    };
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
  diffKind?: Array<DiffKind | null>,
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
