import type { Input, SyntaxNode } from "@lezer/common";
import type { MarkdownParser } from "@lezer/markdown";
import { createBlockSnapshot, inlineNodesToPlainText } from "./block-snapshot";
import type { InlineParser } from "./inline-parser";
import { extractMixedContentSegments } from "./mixed-content";
import { lowerNativeTableContent, type NativeSourceMapping, type NativeSourceReader } from "./native-table-lowering";
import { normalizeFormatAnticipation, prepareInlineStreamingContent } from "./streaming/inline-streaming";
import type { Block, FormatAnticipationConfig, InlineNode, NodeSnapshot, ProtectedRange } from "./types";
import { parseCodeFenceInfo, removeHeadingMarkers } from "./utils";

type SourceText = string | Input;
type NativeNestedBlockSnapshotMapping = NativeSourceMapping & {
  readonly knownListLoosenessForNode?: (node: SyntaxNode) => boolean | undefined;
  readonly coldSourceOffset?: number;
  readonly coldLineEndings?: boolean;
};

function readSourceRange(source: SourceText, from: number, to: number): string {
  return typeof source === "string" ? source.slice(from, to) : source.read(from, to);
}

function sourceCharAt(source: SourceText, index: number): string {
  return typeof source === "string" ? (source[index] ?? "") : source.read(index, index + 1);
}

function lineStartAt(source: SourceText, before: number): number {
  if (typeof source === "string") return source.lastIndexOf("\n", before - 1) + 1;
  let cursor = Math.max(0, Math.min(source.length, before));
  while (cursor > 0 && source.read(cursor - 1, cursor) !== "\n") cursor -= 1;
  return cursor;
}

class StringSourceInput implements Input {
  readonly lineChunks = false;
  readonly length: number;

  constructor(private readonly source: string) {
    this.length = source.length;
  }

  chunk(from: number): string {
    return this.source.slice(from);
  }

  read(from: number, to: number): string {
    return this.source.slice(from, to);
  }
}

interface ColdSourceProjection {
  readonly input: StringSourceInput;
  readonly mapOffset: (offset: number) => number;
}

function projectColdLineEndings(raw: string): ColdSourceProjection | undefined {
  if (!raw.includes("\r")) return undefined;

  let crlfOffsets: number[] | undefined;
  let normalizedOffset = 0;
  for (let physicalOffset = 0; physicalOffset < raw.length; normalizedOffset += 1) {
    if (raw.charCodeAt(physicalOffset) === 13 && raw.charCodeAt(physicalOffset + 1) === 10) {
      (crlfOffsets ??= []).push(normalizedOffset);
      physicalOffset += 2;
    } else {
      physicalOffset += 1;
    }
  }

  const input = new StringSourceInput(raw.replace(/\r\n?/g, "\n"));
  const offsets = crlfOffsets;
  const mapOffset = offsets
    ? (offset: number): number => {
      let low = 0;
      let high = offsets.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (offsets[middle]! < offset) low = middle + 1;
        else high = middle;
      }
      return offset + low;
    }
    : (offset: number): number => offset;
  return { input, mapOffset };
}


export interface PreparedNestedSnapshot {
  props: Record<string, unknown>;
  children: NodeSnapshot[];
}

export type NativeNestedLeafKind = "code" | "table" | "paragraph";
export type NativeNestedLeafFactory = (
  node: SyntaxNode,
  id: string,
  kind: NativeNestedLeafKind,
  range: { readonly from: number; readonly to: number },
) => NodeSnapshot | undefined;
export type NativeNestedChildRole = "item" | "block";
/** Input slot is window-local; the returned slot is canonical and excludes omitted syntax marks. */
export type NativeNestedChildIdentityFactory = (
  parentId: string,
  parentNode: SyntaxNode,
  childNode: SyntaxNode,
  semanticChildIndex: number,
  role: NativeNestedChildRole,
  defaultId: string,
) => Readonly<{ id: string; semanticChildIndex: number }>;
const OMITTED_NESTED_CHILDREN: Record<string, true> = {
  QuoteMark: true,
  ListMark: true,
  LinkReference: true,
};

function sourceRange(mapping: NativeSourceMapping, from: number, to: number): { from: number; to: number } {
  const range = mapping.mapRange?.(from, to) ?? { from: mapping.mapOffset(from), to: mapping.mapOffset(to) };
  if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)
    || range.from < 0 || range.to < range.from || range.to > mapping.source.length) {
    throw new RangeError("Native nested source mapping produced an invalid authored range");
  }
  return { from: range.from, to: range.to };
}

function codeColumnAt(position: number, mapping?: NativeSourceMapping, localSource?: SourceText): number {
  if (mapping) {
    const coldMapping = mapping as NativeNestedBlockSnapshotMapping;
    const physical = mapping.mapOffset(position);
    let start = physical;
    const sourceStart = coldMapping.coldSourceOffset ?? 0;
    while (start > sourceStart) {
      const previous = mapping.source.read(start - 1, start);
      if (previous === "\n" || (coldMapping.coldLineEndings && previous === "\r")) break;
      start -= 1;
    }
    let columns = 0;
    for (let cursor = start; cursor < physical; cursor += 1) {
      columns += mapping.source.read(cursor, cursor + 1) === "\t" ? 4 - (columns % 4) : 1;
    }
    return columns;
  }
  if (!localSource) return 0;
  const start = lineStartAt(localSource, position);
  let columns = 0;
  for (const char of readSourceRange(localSource, start, position)) {
    columns += char === "\t" ? 4 - (columns % 4) : 1;
  }
  return columns;
}


function listItemContentIndent(node: SyntaxNode, source: SourceText): number {
  const mark = node.getChild("ListMark");
  if (!mark) return 0;
  let end = mark.to;
  while (sourceCharAt(source, end) === " " || sourceCharAt(source, end) === "\t") end += 1;
  const afterMark = codeColumnAt(mark.to, undefined, source);
  const spacing = codeColumnAt(end, undefined, source) - afterMark;
  return codeColumnAt(mark.to, undefined, source) - codeColumnAt(mark.from, undefined, source)
    + (spacing >= 1 && spacing <= 4 ? spacing : 1);
}

function stripLeadingColumns(line: string, requiredColumns: number): string {
  let columns = 0;
  let index = 0;
  while (index < line.length && columns < requiredColumns) {
    const char = line[index];
    if (char === " ") {
      columns += 1;
      index += 1;
    } else if (char === "\t") {
      const nextColumns = columns + (4 - (columns % 4));
      if (nextColumns > requiredColumns) {
        return " ".repeat(nextColumns - requiredColumns) + line.slice(index + 1);
      }
      columns = nextColumns;
      index += 1;
    } else {
      break;
    }
  }
  return line.slice(index);
}

function stripListIndent(text: string, listIndent: number): string {
  if (listIndent === 0 || text.length === 0) return text;
  let result = "";
  let from = 0;
  let firstLine = true;
  while (from < text.length) {
    const newline = text.indexOf("\n", from);
    const lineEnd = newline < 0 ? text.length : newline;
    const line = text.slice(from, lineEnd);
    result += firstLine ? line : stripLeadingColumns(line, listIndent);
    if (newline >= 0) result += "\n";
    from = newline < 0 ? text.length : newline + 1;
    firstLine = false;
  }
  return result;
}

function lowerNestedBlockSnapshot(
  block: Block,
  root: SyntaxNode,
  mapping: NativeNestedBlockSnapshotMapping,
  inlineParser: InlineParser,
  parser: MarkdownParser,
  streamingInline: ((text: string) => InlineNode[]) | undefined,
  nativeLeafFactory: NativeNestedLeafFactory | undefined,
  identityForChild: NativeNestedChildIdentityFactory | undefined,
  includeContainerRaw: boolean,
): PreparedNestedSnapshot {
  const input = mapping.input;
  const meta = block.payload.meta as { formatAnticipation?: FormatAnticipationConfig; mathEnabled?: boolean } | undefined;
  const parseInline = (text: string): InlineNode[] => {
    if (block.isFinalized) return inlineParser.parse(text);
    if (streamingInline) return streamingInline(text);
    const formatAnticipation = meta?.formatAnticipation ?? { inline: true, mathInline: true, mathBlock: true, regex: true };
    const regexAppend = normalizeFormatAnticipation(formatAnticipation).regex ? inlineParser.getRegexAnticipationAppend(text) : "";
    const prepared = prepareInlineStreamingContent(text, { formatAnticipation, math: meta?.mathEnabled !== false, regexAppend });
    if (prepared.kind === "raw") return [{ kind: "text", text }];
    return inlineParser.parse(prepared.content, { cache: false });
  };
  const childrenOf = (node: SyntaxNode): SyntaxNode[] => {
    const children: SyntaxNode[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) children.push(child);
    return children;
  };
  const defaultChildId = (
    parentId: string,
    parentNode: SyntaxNode,
    child: SyntaxNode,
    semanticChildIndex: number,
    role: NativeNestedChildRole,
  ): string => role === "item"
    ? `${parentId}::item:${semanticChildIndex}`
    : `${parentId}::${child.type.name.toLowerCase()}:${semanticChildIndex}`;
  const childIdentity = (
    parentId: string,
    parentNode: SyntaxNode,
    child: SyntaxNode,
    semanticChildIndex: number,
    role: NativeNestedChildRole,
  ): Readonly<{ id: string; semanticChildIndex: number }> => {
    const fallbackId = defaultChildId(parentId, parentNode, child, semanticChildIndex, role);
    return identityForChild?.(parentId, parentNode, child, semanticChildIndex, role, fallbackId)
      ?? { id: fallbackId, semanticChildIndex };
  };
  const leafText = (node: SyntaxNode): string => {
    const marks: SyntaxNode[] = [];
    const visit = (child: SyntaxNode) => {
      if (child.type.name === "QuoteMark") marks.push(child);
      else for (const nested of childrenOf(child)) visit(nested);
    };
    visit(node);
    marks.sort((left, right) => left.from - right.from);
    let result = "";
    const readSource = (from: number, to: number): string => {
      const range = sourceRange(mapping, from, to);
      return mapping.source.read(range.from, range.to);
    };
    const sourceCharAtInputOffset = (offset: number): string => {
      const range = sourceRange(mapping, offset, offset);
      return range.from < mapping.source.length ? mapping.source.read(range.from, range.from + 1) : "";
    };
    let from = node.from;
    for (const mark of marks) {
      result += readSource(from, mark.from);
      from = mark.to;
      const next = sourceCharAtInputOffset(from);
      if (next === " " || next === "\t") from += 1;
    }
    result += readSource(from, node.to);
    let listIndent = 0;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.type.name === "ListItem" || parent.type.name === "EmptyListItem") {
        listIndent += listItemContentIndent(parent, input);
      }
    }
    if (result.includes("\r")) result = result.replace(/\r\n?/g, "\n");
    return stripListIndent(result, listIndent);
  };
  const looseList = (node: SyntaxNode): boolean => {
    const knownLooseness = mapping.knownListLoosenessForNode?.(node);
    if (knownLooseness !== undefined) return knownLooseness;
    const items = childrenOf(node).filter((child) => child.type.name === "ListItem" || child.type.name === "EmptyListItem");
    const blankGap = (from: number, to: number): boolean => {
      if (to < from) return false;
      const rawGap = mapping.source.read(from, to);
      return mapping.coldLineEndings
        ? /(?:\r\n|\r|\n)[ >\t]*(?:\r\n|\r|\n)/.test(rawGap)
        : /\r?\n[ >\t]*\r?\n/.test(rawGap);
    };
    const itemStart = (item: SyntaxNode): number => {
      const marker = item.getChild("ListMark");
      return marker
        ? sourceRange(mapping, marker.from, marker.to).from
        : sourceRange(mapping, item.from, item.to).from;
    };
    const itemContentEnd = (item: SyntaxNode): number => {
      const marker = item.getChild("ListMark");
      let end = marker
        ? sourceRange(mapping, marker.from, marker.to).to
        : sourceRange(mapping, item.from, item.to).from;
      for (const child of childrenOf(item)) {
        if (["ListMark", "QuoteMark", "LinkReference"].includes(child.type.name)) continue;
        end = sourceRange(mapping, child.from, child.to).to;
      }
      return end;
    };
    return items.some((item, index) => {
      const previous = items[index - 1];
      if (previous && blankGap(itemContentEnd(previous), itemStart(item))) return true;
      const children = childrenOf(item).filter((child) => !["ListMark", "QuoteMark", "LinkReference"].includes(child.type.name));
      return children.some((child, childIndex) => {
        if (childIndex === 0) return false;
        const previousRange = sourceRange(mapping, children[childIndex - 1]!.from, children[childIndex - 1]!.to);
        const childRange = sourceRange(mapping, child.from, child.to);
        return blankGap(previousRange.to, childRange.from);
      });
    });
  };
  const readRaw = (node: SyntaxNode): string => {
    const range = sourceRange(mapping, node.from, node.to);
    return mapping.source.read(range.from, range.to);
  };
  const build = (node: SyntaxNode, id: string, container: "list" | "blockquote"): NodeSnapshot | null => {
    const name = node.type.name;
    if (OMITTED_NESTED_CHILDREN[name]) return null;
    const range = sourceRange(mapping, node.from, node.to);
    const baseMeta: Record<string, unknown> = { sourceContainer: container };
    if (name === "Paragraph" || name === "Task") {
      const owned = nativeLeafFactory?.(node, id, "paragraph", range);
      if (owned) return owned;
    }
    if (name === "BulletList" || name === "OrderedList") {
      const ordered = name === "OrderedList";
      const loose = looseList(node);
      const mark = node.firstChild?.getChild("ListMark");
      const start = ordered && mark ? Number.parseInt(input.read(mark.from, mark.to), 10) : undefined;
      const props = { ordered, loose, start: start === 1 ? undefined : start };
      const items = childrenOf(node).filter((child) => child.type.name === "ListItem" || child.type.name === "EmptyListItem");
      const children = items.map((item, semanticChildIndex): NodeSnapshot => {
        const itemIdentity = childIdentity(id, node, item, semanticChildIndex, "item");
        const itemId = itemIdentity.id;
        const content = childrenOf(item).filter((child) => !["ListMark", "QuoteMark", "LinkReference"].includes(child.type.name));
        const first = content[0];
        const primary = first && (first.type.name === "Paragraph" || first.type.name === "Task") ? first : undefined;
        const primarySemanticIndex = primary ? content.indexOf(primary) : -1;
        const primaryRange = primary ? sourceRange(mapping, primary.from, primary.to) : undefined;
        const taskMarker = primary?.type.name === "Task" ? primary.getChild("TaskMarker") : null;
        const taskMarkerRange = taskMarker ? sourceRange(mapping, taskMarker.from, taskMarker.to) : undefined;
        const taskValue = taskMarkerRange
          ? /^\[([ xX])\]$/.exec(mapping.source.read(taskMarkerRange.from, taskMarkerRange.to))
          : null;
        const isTask = primary?.type.name === "Task";
        const primaryId = primary
          ? childIdentity(itemId, item, primary, primarySemanticIndex, "block").id
          : undefined;
        const primaryChild = primary && primaryRange && primaryId
          ? nativeLeafFactory?.(primary, primaryId, "paragraph", primaryRange)
          : undefined;
        if (primaryChild) {
          primaryChild.props = { ...(primaryChild.props ?? {}), listItemPrimary: true };
        }
        let inline: InlineNode[] | undefined;
        const segmentChildren: NodeSnapshot[] = [];
        if (primary && !primaryChild) {
          const text = leafText(primary);
          const taskPrefix = isTask ? text.match(/^\[([ xX])\][ \t]+/) : null;
          const primaryText = taskPrefix ? text.slice(taskPrefix[0].length) : text;
          inline = parseInline(primaryText);
          const baseOffset = primaryRange
            ? sourceRange(
                mapping,
                primary.from + (taskPrefix?.[0].length ?? 0),
                primary.from + (taskPrefix?.[0].length ?? 0),
              ).from
            : range.from;
          const protectedRanges: ProtectedRange[] = [];
          if (primaryText.includes("`")) {
            const cursor = parser.parse(primaryText).cursor();
            do {
              if (cursor.name === "InlineCode") protectedRanges.push({ from: baseOffset + cursor.from, to: baseOffset + cursor.to, kind: "code-inline" });
            } while (cursor.next());
          }
          const segments = extractMixedContentSegments(primaryText, baseOffset, parseInline, { protectedRanges });
          const structured = segments.some((segment) => segment.kind === "mdx");
          if (structured) {
            segmentChildren.push(...segments.map((segment, segmentIndex): NodeSnapshot => ({
              id: `${itemId}::list-item:segment:${segmentIndex}`,
              type: `list-item-${segment.kind}`,
              props: segment.kind === "text" ? { inline: segment.inline, text: segment.value }
                : segment.kind === "html" ? { raw: segment.value, html: segment.sanitized ?? segment.value }
                : { raw: segment.value, status: segment.status ?? "pending", error: segment.error },
              children: [],
            })));
          }
        }
        content.forEach((child, semanticChildIndex) => {
          if (child === primary) return;
          const identity = childIdentity(itemId, item, child, semanticChildIndex, "block");
          const childSnapshot = build(child, identity.id, "list");
          if (childSnapshot) segmentChildren.push(childSnapshot);
        });
        const mappedItemRange = sourceRange(mapping, item.from, item.to);
        const primaryOwnerRange = primaryChild?.paragraph?.sourceRange;
        // A retained typed paragraph can outlive the bounded native context node for its list item.
        const itemRange = primaryOwnerRange
          && primaryOwnerRange.from >= mappedItemRange.from
          && primaryOwnerRange.to > mappedItemRange.to
          ? { from: mappedItemRange.from, to: primaryOwnerRange.to }
          : mappedItemRange;
        const itemRaw = includeContainerRaw ? readRaw(item) : "";
        const itemBlock: Block = {
          id: itemId,
          type: "list-item",
          isFinalized: block.isFinalized,
          payload: {
            raw: itemRaw,
            ...(primaryChild ? {} : { inline: inline ?? [] }),
            range: itemRange,
            meta: { sourceContainer: "list" },
          },
        };
        const itemChildren = primaryChild ? [primaryChild, ...segmentChildren] : segmentChildren;
        return {
          id: itemId,
          type: "list-item",
          range: itemRange,
          props: {
            ...(primaryChild ? {} : props),
            block: itemBlock,
            index: itemIdentity.semanticChildIndex,
            ...(primaryChild ? {} : {
              inline: inline ?? [],
              text: inlineNodesToPlainText(inline ?? []),
            }),
            raw: itemRaw,
            task: isTask ? true : undefined,
            checked: isTask ? taskValue?.[1]?.toLowerCase() === "x" : undefined,
          },
          children: itemChildren,
        };
      });
      const nested: Block = {
        id,
        type: "list",
        isFinalized: block.isFinalized,
        payload: {
          raw: includeContainerRaw ? readRaw(node) : "",
          range,
          meta: { ...baseMeta, ...props },
        },
      };
      return { id, type: "list", props: { block: nested, ...props }, range, children };
    }
    if (name === "Blockquote") {
      const children: NodeSnapshot[] = [];
      let semanticChildIndex = 0;
      for (const child of childrenOf(node)) {
        if (OMITTED_NESTED_CHILDREN[child.type.name]) continue;
        const identity = childIdentity(id, node, child, semanticChildIndex, "block");
        const childSnapshot = build(child, identity.id, "blockquote");
        if (childSnapshot) children.push(childSnapshot);
        // The native semantic slot advances even when lowering omits an empty snapshot.
        semanticChildIndex += 1;
      }
      const nested: Block = {
        id,
        type: "blockquote",
        isFinalized: block.isFinalized,
        payload: { raw: includeContainerRaw ? readRaw(node) : "", range, meta: baseMeta },
      };
      return { id, type: "blockquote", props: { block: nested }, range, children };
    }
    if (name === "Table") {
      const owned = nativeLeafFactory?.(node, id, "table", range);
      if (owned) return owned;
      const table = lowerNativeTableContent(node, mapping, inlineParser);
      if (!table) return null;
      const nested: Block = {
        id,
        type: "table",
        isFinalized: block.isFinalized,
        payload: {
          raw: readRaw(node),
          range,
          meta: {
            ...baseMeta,
            lezerNodeType: name,
            header: table.header,
            align: table.align,
            rows: table.rows,
          },
        },
      };
      return createBlockSnapshot(nested);
    }
    let type: Block["type"] = "paragraph";
    let display = leafText(node);
    let inline: InlineNode[] | undefined;
    if (name === "Paragraph" && !display.trim()) return null;
    if (name === "FencedCode" || name === "CodeBlock" || name === "IndentedCode") {
      type = "code";
      const owned = nativeLeafFactory?.(node, id, "code", range);
      if (owned) return owned;
      const { code, info } = extractLezerCode(node, input, mapping);
      const fence = parseCodeFenceInfo(info);
      baseMeta.code = code;
      baseMeta.info = info;
      if (fence.lang) baseMeta.lang = fence.lang;
      Object.assign(baseMeta, fence.meta);
      display = readRaw(node);
    } else if (name.startsWith("ATXHeading") || name.startsWith("SetextHeading")) {
      type = "heading";
      baseMeta.headingLevel = Number(name.slice(name.startsWith("ATX") ? 10 : 13)) || 1;
      inline = parseInline(removeHeadingMarkers(display));
    } else if (name === "HorizontalRule") {
      type = "hr";
    } else if (name === "HTMLBlock" || name === "CommentBlock" || name === "ProcessingInstructionBlock") {
      type = "html";
      baseMeta.lezerNodeType = name;
    } else {
      inline = parseInline(display);
    }
    const nested: Block = {
      id,
      type,
      isFinalized: block.isFinalized,
      // HTML renders from its raw, so it keeps the container-marker-free text (base behavior).
      payload: { raw: type === "html" ? display : readRaw(node), inline, range, meta: baseMeta },
    };
    const snapshot = createBlockSnapshot(nested);
    if (type === "paragraph") snapshot.props = { ...snapshot.props, inline, text: inlineNodesToPlainText(inline ?? []) };
    return snapshot;
  };

  const snapshot = build(root, block.id, block.type === "list" ? "list" : "blockquote");
  if (!snapshot) return { props: {}, children: [] };
  const { block: _block, ...props } = snapshot.props ?? {};
  return { props, children: snapshot.children ?? [] };
}

/** Direct lowering of a native container AST into generic nested snapshots. */
export function prepareNestedBlockSnapshotFromNative(
  block: Block,
  root: SyntaxNode,
  mapping: NativeSourceMapping,
  inlineParser: InlineParser,
  parser: MarkdownParser,
  streamingInline?: (text: string) => InlineNode[],
  nativeLeafFactory?: NativeNestedLeafFactory,
  identityForChild?: NativeNestedChildIdentityFactory,
): PreparedNestedSnapshot {
  const preparedMapping: NativeNestedBlockSnapshotMapping = {
    ...mapping,
    mapRange: mapping.mapRange ?? ((from, to) => ({ from: mapping.mapOffset(from), to: mapping.mapOffset(to) })),
  };
  return lowerNestedBlockSnapshot(
    block,
    root,
    preparedMapping,
    inlineParser,
    parser,
    streamingInline,
    nativeLeafFactory,
    identityForChild,
    false,
  );
}

/** Cold legacy preparation parses once, then delegates the existing native tree to the same lowerer. */
export function prepareNestedBlockSnapshot(
  block: Block,
  inlineParser: InlineParser,
  parser: MarkdownParser,
  streamingInline?: (text: string) => InlineNode[],
): PreparedNestedSnapshot {
  const raw = block.payload.raw;
  const projection = projectColdLineEndings(raw);
  const input = projection?.input ?? new StringSourceInput(raw);
  const tree = parser.parse(projection ? input : raw);
  const offset = block.payload.range?.from ?? 0;
  const source: NativeSourceReader = {
    length: offset + raw.length,
    read: (from, to) => raw.slice(from - offset, to - offset),
  };
  const mapColdOffset = projection?.mapOffset;
  const mapping: NativeNestedBlockSnapshotMapping = {
    input,
    source,
    coldSourceOffset: offset,
    coldLineEndings: projection !== undefined,
    mapOffset: (position) => offset + (mapColdOffset ? mapColdOffset(position) : position),
    mapRange: (from, to) => ({
      from: offset + (mapColdOffset ? mapColdOffset(from) : from),
      to: offset + (mapColdOffset ? mapColdOffset(to) : to),
    }),
  };
  const root = tree.topNode.firstChild;
  if (!root) return { props: {}, children: [] };
  return lowerNestedBlockSnapshot(
    block,
    root,
    mapping,
    inlineParser,
    parser,
    streamingInline,
    undefined,
    undefined,
    true,
  );
}

/** CodeText ranges already exclude container indentation, unlike the enclosing raw block. */
export function extractLezerCode(
  node: SyntaxNode,
  source: SourceText,
  mapping?: NativeSourceMapping,
): { code: string; info: string } {
  const columnAt = (position: number): number => codeColumnAt(position, mapping, source);
  let baseIndent = 0;
  const parents: SyntaxNode[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) parents.unshift(parent);
  for (const parent of parents) {
    if (parent.type.name === "ListItem" || parent.type.name === "EmptyListItem") {
      const mark = parent.getChild("ListMark");
      if (mark) {
        let end = mark.to;
        while (sourceCharAt(source, end) === " " || sourceCharAt(source, end) === "\t") end += 1;
        const afterMark = columnAt(mark.to);
        const spacing = columnAt(end) - afterMark;
        baseIndent = afterMark + (spacing >= 1 && spacing <= 4 ? spacing : 1);
      }
    } else if (parent.type.name === "Blockquote") {
      const mark = parent.getChild("QuoteMark");
      if (mark) baseIndent = columnAt(mark.to) + (sourceCharAt(source, mark.to) === " " || sourceCharAt(source, mark.to) === "\t" ? 1 : 0);
    }
  }
  const fenced = node.type.name === "FencedCode";
  const fenceIndent = fenced ? Math.max(0, columnAt(node.from) - baseIndent) : 0;
  let code = "";
  let previousCodeEnd = node.from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.type.name !== "CodeText") continue;
    let text = readSourceRange(source, child.from, child.to);
    if (!fenced && sourceCharAt(source, child.from) === "\n") {
      const lineStart = lineStartAt(source, child.from);
      if (lineStart >= previousCodeEnd) {
        let position = lineStart;
        const requiredColumns = baseIndent + 4;
        let columns = 0;
        while (position < child.from && columns < requiredColumns) {
          columns += sourceCharAt(source, position) === "\t" ? 4 - (columns % 4) : 1;
          position += 1;
        }
        const remaining = readSourceRange(source, position, child.from);
        if (/^[ \t]*$/.test(remaining)) {
          text = " ".repeat(Math.max(0, columns - requiredColumns)) + remaining + text;
        }
      }
    }
    if (!fenced && sourceCharAt(source, child.from) !== "\n" && sourceCharAt(source, child.from - 1) === "\t") {
      text = " ".repeat(Math.max(0, columnAt(child.from) - baseIndent - 4)) + text;
    }
    if (fenceIndent > 0) text = text.split("\n").map((line) => stripLeadingColumns(line, fenceIndent)).join("\n");
    code += text;
    previousCodeEnd = child.to;
  }
  const infoNode = node.getChild("CodeInfo");
  return { code, info: infoNode ? readSourceRange(source, infoNode.from, infoNode.to) : "" };
}
