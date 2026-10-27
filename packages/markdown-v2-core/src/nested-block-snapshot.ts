import type { Input, SyntaxNode } from "@lezer/common";
import type { MarkdownParser } from "@lezer/markdown";
import { createBlockSnapshot, inlineNodesToPlainText } from "./block-snapshot";
import type { InlineParser } from "./inline-parser";
import { extractMixedContentSegments } from "./mixed-content";
import { lowerNativeTableContent, type NativeSourceMapping, type NativeSourceReader } from "./native-table-lowering";
import { normalizeFormatAnticipation, prepareInlineStreamingContent } from "./streaming/inline-streaming";
import type { Block, FormatAnticipationConfig, InlineNode, NodeSnapshot, ProtectedRange } from "./types";
import { parseCodeFenceInfo, removeHeadingMarkers } from "./utils";

type SourceText = string | Input | NativeSourceReader;
type NativeNestedBlockSnapshotMapping = NativeSourceMapping & {
  readonly knownListLoosenessForNode?: (node: SyntaxNode) => boolean | undefined;
  readonly coldSourceOffset?: number;
  readonly coldLineEndings?: boolean;
  readonly presentationInput?: Input;
  readonly presentationPrefix?: string;
  readonly recoveryRootRange?: { readonly from: number; readonly to: number };
  readonly markListIndentationRecoveryContent?: boolean;
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

/** Leading characters to drop for `requiredColumns`; a split tab leaves `pad` spaces. */
function leadingColumnCut(line: string, requiredColumns: number): { skip: number; pad: number } {
  let columns = 0;
  let index = 0;
  while (index < line.length && columns < requiredColumns) {
    const char = line[index];
    if (char === " ") {
      columns += 1;
      index += 1;
    } else if (char === "\t") {
      const nextColumns = columns + (4 - (columns % 4));
      if (nextColumns > requiredColumns) return { skip: index + 1, pad: nextColumns - requiredColumns };
      columns = nextColumns;
      index += 1;
    } else {
      break;
    }
  }
  return { skip: index, pad: 0 };
}

function stripLeadingColumns(line: string, requiredColumns: number): string {
  const cut = leadingColumnCut(line, requiredColumns);
  return " ".repeat(cut.pad) + line.slice(cut.skip);
}

/** Leaf display text; `positions` holds every character's authored offset when requested. */
interface LeafText {
  readonly text: string;
  readonly positions?: readonly number[];
}

function normalizeLeafLineEndings(leaf: LeafText): LeafText {
  const { text, positions } = leaf;
  if (!text.includes("\r")) return leaf;
  if (!positions) return { text: text.replace(/\r\n?/g, "\n") };
  let result = "";
  const resultPositions: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\r" && text[index + 1] === "\n") continue;
    result += char === "\r" ? "\n" : char;
    resultPositions.push(positions[index]!);
  }
  return { text: result, positions: resultPositions };
}

function stripListIndent(leaf: LeafText, listIndent: number): LeafText {
  const { text, positions } = leaf;
  if (listIndent === 0 || text.length === 0) return leaf;
  let result = "";
  const resultPositions = positions ? [] as number[] : undefined;
  let from = 0;
  let firstLine = true;
  while (from < text.length) {
    const newline = text.indexOf("\n", from);
    const lineEnd = newline < 0 ? text.length : newline;
    const cut = firstLine ? { skip: 0, pad: 0 } : leadingColumnCut(text.slice(from, lineEnd), listIndent);
    result += " ".repeat(cut.pad) + text.slice(from + cut.skip, lineEnd);
    if (newline >= 0) result += "\n";
    if (resultPositions && positions) {
      // Padding from a split tab maps to the tab itself.
      for (let pad = 0; pad < cut.pad; pad += 1) resultPositions.push(positions[from + cut.skip - 1]!);
      for (let index = from + cut.skip; index < lineEnd; index += 1) resultPositions.push(positions[index]!);
      if (newline >= 0) resultPositions.push(positions[newline]!);
    }
    from = newline < 0 ? text.length : newline + 1;
    firstLine = false;
  }
  return resultPositions ? { text: result, positions: resultPositions } : { text: result };
}

/** Rebinds leaf-local inline source ranges to authored offsets. */
function mapInlineSourceRanges(nodes: InlineNode[], positions: readonly number[]): InlineNode[] {
  return nodes.map((node) => {
    const range = node.sourceRange;
    let sourceRange: { from: number; to: number } | undefined;
    if (
      range &&
      Number.isSafeInteger(range.from) &&
      Number.isSafeInteger(range.to) &&
      range.from >= 0 &&
      range.to > range.from &&
      range.to <= positions.length
    ) {
      const authoredFrom = positions[range.from];
      const authoredEnd = positions[range.to - 1];
      if (Number.isSafeInteger(authoredFrom) && Number.isSafeInteger(authoredEnd)) {
        sourceRange = { from: authoredFrom!, to: authoredEnd! + 1 };
      }
    }
    const { sourceRange: _localRange, ...rest } = node;
    return {
      ...rest,
      ...(sourceRange ? { sourceRange } : {}),
      ...("children" in node && Array.isArray(node.children) ? { children: mapInlineSourceRanges(node.children, positions) } : {}),
    } as InlineNode;
  });
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
  const meta = block.payload.meta as {
    formatAnticipation?: FormatAnticipationConfig;
    mathEnabled?: boolean;
    trustedMdxSource?: boolean;
  } | undefined;
  // Finalized trusted-MDX sources keep authored inline ranges for compiler-owned native children.
  const trustedSource = meta?.trustedMdxSource === true && block.isFinalized;
  const parseInline = (text: string, positions?: readonly number[]): InlineNode[] => {
    if (mapping.presentationInput && positions) {
      return mapInlineSourceRanges(inlineParser.parse(text, { cache: false, sourceOffset: 0 }), positions);
    }
    if (block.isFinalized) {
      return trustedSource && positions
        ? mapInlineSourceRanges(inlineParser.parse(text, { sourceOffset: 0 }), positions)
        : inlineParser.parse(text);
    }
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
  const leafText = (node: SyntaxNode, withPositions = false): LeafText => {
    const marks: SyntaxNode[] = [];
    const visit = (child: SyntaxNode) => {
      if (child.type.name === "QuoteMark") marks.push(child);
      else for (const nested of childrenOf(child)) visit(nested);
    };
    visit(node);
    marks.sort((left, right) => left.from - right.from);
    let result = "";
    const positions = withPositions && (trustedSource || mapping.presentationInput) ? [] as number[] : undefined;
    const appendSource = (from: number, to: number): void => {
      if (mapping.presentationInput) {
        result += mapping.presentationInput.read(from, to);
        if (positions) {
          for (let position = from; position < to; position += 1) {
            positions.push(sourceRange(mapping, position, position + 1).from);
          }
        }
        return;
      }
      const range = sourceRange(mapping, from, to);
      result += mapping.source.read(range.from, range.to);
      if (positions) for (let position = range.from; position < range.to; position += 1) positions.push(position);
    };
    const sourceCharAtInputOffset = (offset: number): string => {
      if (mapping.presentationInput) return sourceCharAt(mapping.presentationInput, offset);
      const range = sourceRange(mapping, offset, offset);
      return range.from < mapping.source.length ? mapping.source.read(range.from, range.from + 1) : "";
    };
    let from = node.from;
    for (const mark of marks) {
      appendSource(from, mark.from);
      from = mark.to;
      const next = sourceCharAtInputOffset(from);
      if (next === " " || next === "\t") from += 1;
    }
    appendSource(from, node.to);
    let listIndent = 0;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.type.name === "ListItem" || parent.type.name === "EmptyListItem") {
        listIndent += listItemContentIndent(parent, input);
      }
    }
    const leaf = stripListIndent(normalizeLeafLineEndings(positions ? { text: result, positions } : { text: result }), listIndent);
    const prefix = mapping.presentationPrefix;
    if (node.from === 0 && prefix && leaf.text.startsWith(prefix)) {
      return {
        text: leaf.text.slice(prefix.length),
        ...(leaf.positions ? { positions: leaf.positions.slice(prefix.length) } : {}),
      };
    }
    return leaf;
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
    const baseMeta: Record<string, unknown> = {
      sourceContainer: container,
      ...(mapping.presentationInput && mapping.markListIndentationRecoveryContent !== false
        ? { listIndentationRecoveryContent: true }
        : {}),
    };
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
      const children = items.flatMap((item, semanticChildIndex): NodeSnapshot[] => {
        const itemIdentity = childIdentity(id, node, item, semanticChildIndex, "item");
        const itemId = itemIdentity.id;
        const recoveredItems = block.payload.meta?.listIndentationRecovery === true && ordered
          ? recoverOrderedListContinuation(
              item,
              node,
              id,
              itemIdentity,
              block,
              mapping,
              inlineParser,
              parser,
              streamingInline,
            )
          : undefined;
        if (recoveredItems) return recoveredItems;
        const content = childrenOf(item).filter((child) => !["ListMark", "QuoteMark", "LinkReference"].includes(child.type.name));
        const first = content[0];
        const candidate = first && (first.type.name === "Paragraph" || first.type.name === "Task") ? first : undefined;
        const candidateRange = candidate ? sourceRange(mapping, candidate.from, candidate.to) : undefined;
        const itemMark = item.getChild("ListMark");
        const itemContentStart = itemMark ? sourceRange(mapping, itemMark.from, itemMark.to).to : range.from;
        const primary = candidate && candidateRange && mapping.source.read(itemContentStart, candidateRange.from).trim() === ""
          ? candidate
          : undefined;
        const primarySemanticIndex = primary ? content.indexOf(primary) : -1;
        const primaryRange = primary ? candidateRange : undefined;
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
        let primarySourcePositions: readonly number[] | undefined;
        const segmentChildren: NodeSnapshot[] = [];
        let recoveredListIndentation = false;
        if (primary && !primaryChild) {
          const leaf = leafText(primary, true);
          const taskPrefix = isTask ? leaf.text.match(/^\[([ xX])\][ \t]+/) : null;
          const primaryText = taskPrefix ? leaf.text.slice(taskPrefix[0].length) : leaf.text;
          primarySourcePositions = leaf.positions?.slice(taskPrefix?.[0].length ?? 0);
          inline = parseInline(primaryText, primarySourcePositions);
          // Trusted sources leave JSX to the trusted compiler, so they never split native MDX segments.
          if (!trustedSource) {
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
            if (segments.some((segment) => segment.kind === "mdx")) {
              segmentChildren.push(...segments.map((segment, segmentIndex): NodeSnapshot => ({
                id: `${itemId}::list-item:segment:${segmentIndex}`,
                type: `list-item-${segment.kind}`,
                range: segment.range ? { ...segment.range } : undefined,
                props: segment.kind === "text" ? { inline: segment.inline, text: segment.value }
                  : segment.kind === "html" ? { raw: segment.value, html: segment.sanitized ?? segment.value }
                  : { raw: segment.value },
                children: [],
              })));
            }
          }
        }
        content.forEach((child, semanticChildIndex) => {
          if (child === primary) return;
          const identity = childIdentity(itemId, item, child, semanticChildIndex, "block");
          const recovered = block.payload.meta?.listIndentationRecovery === true
            ? recoverListIndentationCode(child, item, identity.id, block, mapping, inlineParser, parser, streamingInline)
            : undefined;
          if (recovered) {
            recoveredListIndentation = true;
            segmentChildren.push(...recovered.children);
            return;
          }
          const childSnapshot = build(child, identity.id, "list");
          if (childSnapshot) segmentChildren.push(childSnapshot);
        });
        const mappedItemRange = sourceRange(mapping, item.from, item.to);
        let itemTo = mappedItemRange.to;
        const primaryOwnerRange = primaryChild?.paragraph?.sourceRange;
        // A retained source owner or nested child can outlive the bounded parser context for its list item.
        if (primaryOwnerRange?.from !== undefined && primaryOwnerRange.from >= mappedItemRange.from) {
          itemTo = Math.max(itemTo, primaryOwnerRange.to);
        }
        for (const child of segmentChildren) {
          if (child.range && child.range.from >= mappedItemRange.from) {
            itemTo = Math.max(itemTo, child.range.to);
          }
        }
        const itemRange = itemTo > mappedItemRange.to
          ? { from: mappedItemRange.from, to: itemTo }
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
            meta: {
              sourceContainer: "list",
              ...(primarySourcePositions ? { inlineSourcePositions: primarySourcePositions } : {}),
              ...(recoveredListIndentation ? { listIndentationRecovered: true } : {}),
              ...(taskMarkerRange ? { taskMarkerOffset: taskMarkerRange.from } : {}),
            },
          },
        };
        const itemChildren = primaryChild ? [primaryChild, ...segmentChildren] : segmentChildren;
        return [{
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
            ...(taskMarkerRange ? { taskMarkerOffset: taskMarkerRange.from } : {}),
            task: isTask ? true : undefined,
            checked: isTask ? taskValue?.[1]?.toLowerCase() === "x" : undefined,
          },
          children: itemChildren,
        }];
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
    const isHeading = name.startsWith("ATXHeading") || name.startsWith("SetextHeading");
    const leaf = leafText(node, name === "Paragraph" || isHeading);
    let display = leaf.text;
    let inlineSourcePositions = leaf.positions;
    let inlineSourceText: string | undefined;
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
    } else if (isHeading) {
      type = "heading";
      baseMeta.headingLevel = Number(name.slice(name.startsWith("ATX") ? 10 : 13)) || 1;
      const headingText = removeHeadingMarkers(display);
      inlineSourceText = headingText;
      if (inlineSourcePositions) {
        const prefixLength = /^(?:#{1,6})(?:\s+|$)/.exec(display)?.[0].length ?? 0;
        inlineSourcePositions = inlineSourcePositions.slice(prefixLength, prefixLength + headingText.length);
      }
      inline = parseInline(headingText, inlineSourcePositions);
    } else if (name === "HorizontalRule") {
      type = "hr";
    } else if (name === "HTMLBlock" || name === "CommentBlock" || name === "ProcessingInstructionBlock") {
      type = "html";
      baseMeta.lezerNodeType = name;
    } else {
      inlineSourceText = display;
      inline = parseInline(display, inlineSourcePositions);
    }
    const raw = type === "html" ? display : readRaw(node);
    const nested: Block = {
      id,
      type,
      isFinalized: block.isFinalized,
      // HTML renders from its raw, so it keeps the container-marker-free text (base behavior).
      payload: { raw, inline, range, meta: baseMeta },
    };
    const snapshot = createBlockSnapshot(nested);
    if (type === "paragraph") snapshot.props = { ...snapshot.props, inline, text: inlineNodesToPlainText(inline ?? []) };
    const snapshotBlock = inlineSourcePositions ? snapshot.props?.block as Block | undefined : undefined;
    if (snapshotBlock) {
      snapshotBlock.payload.meta = {
        ...snapshotBlock.payload.meta,
        inlineSourcePositions,
        ...(inlineSourceText !== undefined && inlineSourceText !== raw ? { inlineSourceText } : {}),
      };
    }
    return snapshot;
  };

  if (root.type.name === "Document") {
    const children: NodeSnapshot[] = [];
    const container = block.type === "list" ? "list" : "blockquote";
    childrenOf(root).forEach((child, index) => {
      const snapshot = build(child, `${block.id}::recovered:${index}`, container);
      if (!snapshot) return;
      if (index === 0 && mapping.recoveryRootRange) {
        const range = mapping.recoveryRootRange;
        snapshot.range = { ...range };
        const recoveredBlock = snapshot.props?.block as Block | undefined;
        if (recoveredBlock) {
          snapshot.props = {
            ...snapshot.props,
            block: {
              ...recoveredBlock,
              payload: {
                ...recoveredBlock.payload,
                raw: mapping.source.read(range.from, range.to),
                range: { ...range },
              },
            },
          };
        }
      }
      children.push(snapshot);
    });
    return { props: {}, children };
  }
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

interface DetailedLezerCode {
  readonly code: string;
  readonly info: string;
  readonly sourcePositions?: readonly number[];
}

function extractLezerCodeDetailed(
  node: SyntaxNode,
  source: SourceText,
  mapping: NativeSourceMapping | undefined,
  captureSourcePositions: boolean,
): DetailedLezerCode {
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
  let sourcePositions: number[] | undefined;
  let previousCodeEnd = node.from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.type.name !== "CodeText") continue;
    let text = readSourceRange(source, child.from, child.to);
    const parts: Array<{ text: string; from?: number; generatedAt?: number }> | undefined =
      captureSourcePositions ? [{ text, from: child.from }] : undefined;

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
          const paddingCount = Math.max(0, columns - requiredColumns);
          const padding = " ".repeat(paddingCount);
          text = padding + remaining + text;
          if (parts) {
            if (remaining.length > 0) parts.unshift({ text: remaining, from: position });
            if (padding.length > 0) parts.unshift({ text: padding, generatedAt: position - 1 });
          }
        }
      }
    }
    if (!fenced && sourceCharAt(source, child.from) !== "\n" && sourceCharAt(source, child.from - 1) === "\t") {
      const padding = " ".repeat(Math.max(0, columnAt(child.from) - baseIndent - 4));
      text = padding + text;
      if (parts && padding.length > 0) parts.unshift({ text: padding, generatedAt: child.from - 1 });
    }
    if (fenceIndent > 0) text = text.split("\n").map((line) => stripLeadingColumns(line, fenceIndent)).join("\n");
    if (
      captureSourcePositions &&
      !fenced &&
      fenceIndent === 0 &&
      sourcePositions === undefined &&
      code.length === 0 &&
      /^[\t ]/.test(text)
    ) {
      sourcePositions = [];
    }
    if (sourcePositions && parts) {
      for (const part of parts) {
        if (part.generatedAt !== undefined) {
          const range = mapping
            ? sourceRange(mapping, part.generatedAt, part.generatedAt + 1)
            : { from: part.generatedAt, to: part.generatedAt + 1 };
          for (let index = 0; index < part.text.length; index += 1) sourcePositions.push(range.from);
        } else if (part.from !== undefined) {
          for (let offset = part.from; offset < part.from + part.text.length; offset += 1) {
            const range = mapping ? sourceRange(mapping, offset, offset + 1) : { from: offset, to: offset + 1 };
            sourcePositions.push(range.from);
          }
        }
      }
    }
    code += text;
    previousCodeEnd = child.to;
  }
  if (fenced && node.getChildren("CodeMark").length < 2) code = code.replace(/(?:\r\n|\n|\r)$/, "");
  const infoNode = node.getChild("CodeInfo");
  const info = infoNode ? readSourceRange(source, infoNode.from, infoNode.to) : "";
  if (sourcePositions) {
    const normalized = normalizeLeafLineEndings({ text: code, positions: sourcePositions });
    return { code: normalized.text, info, sourcePositions: normalized.positions };
  }
  return { code, info };
}

/** CodeText ranges already exclude container indentation, unlike the enclosing raw block. */
export function extractLezerCode(
  node: SyntaxNode,
  source: SourceText,
  mapping?: NativeSourceMapping,
): { code: string; info: string } {
  return extractLezerCodeDetailed(node, source, mapping, false);
}

interface OrderedListRecoveryEdit {
  readonly from: number;
  readonly to: number;
  readonly replacement: string;
}

function indentationColumn(prefix: string, start = 0): number {
  let column = start;
  for (const character of prefix) {
    column += character === "\t" ? 4 - (column % 4) : 1;
  }
  return column;
}

/** Reparse lazy ordered-list continuation text and map the corrected syntax to authored offsets. */
function recoverOrderedListContinuation(
  item: SyntaxNode,
  parentList: SyntaxNode,
  parentListId: string,
  itemIdentity: Readonly<{ id: string; semanticChildIndex: number }>,
  sourceBlock: Block,
  mapping: NativeNestedBlockSnapshotMapping,
  inlineParser: InlineParser,
  parser: MarkdownParser,
  streamingInline: ((text: string) => InlineNode[]) | undefined,
): NodeSnapshot[] | undefined {
  if (parentList.type.name !== "OrderedList") return undefined;
  const marker = item.getChild("ListMark");
  if (!marker) return undefined;

  const lineStart = lineStartAt(mapping.input, marker.from);
  if (!/^[\t ]*$/.test(readSourceRange(mapping.input, lineStart, marker.from))) return undefined;
  const inputRange = sourceRange(mapping, lineStart, item.to);
  const raw = readSourceRange(mapping.input, lineStart, item.to);
  if (!raw) return undefined;

  const sourceText = raw.replace(/\r\n?/g, "\n");
  const firstLineEnd = sourceText.indexOf("\n");
  const firstLine = sourceText.slice(0, firstLineEnd < 0 ? sourceText.length : firstLineEnd);
  const parentMarker = /^([ \t]*)(\d{1,9})([.)])(?=[ \t]+|$)([ \t]*)/.exec(firstLine);
  if (!parentMarker) return undefined;

  const parentMarkerColumn = indentationColumn(parentMarker[1]!);
  const markerEndColumn = parentMarkerColumn + parentMarker[2]!.length + parentMarker[3]!.length;
  const markerPadding = indentationColumn(parentMarker[4] ?? "", markerEndColumn) - markerEndColumn;
  const contentColumn = markerEndColumn + (markerPadding >= 1 && markerPadding <= 4 ? markerPadding : 1);
  const edits: OrderedListRecoveryEdit[] = [];
  let lineFrom = firstLineEnd < 0 ? sourceText.length : firstLineEnd + 1;
  while (lineFrom < sourceText.length) {
    const lineEnd = sourceText.indexOf("\n", lineFrom);
    const lineTo = lineEnd < 0 ? sourceText.length : lineEnd;
    const line = sourceText.slice(lineFrom, lineTo);
    const bullet = /^([ \t]*)([-+*])(?=[ \t]+|$)/.exec(line);
    if (bullet) {
      const bulletColumn = indentationColumn(bullet[1]!);
      if (bulletColumn > parentMarkerColumn && bulletColumn < contentColumn) {
        const markerFrom = lineFrom + bullet[1]!.length;
        edits.push({
          from: markerFrom,
          to: markerFrom,
          replacement: " ".repeat(contentColumn - bulletColumn),
        });
      }
    } else {
      const sibling = /^([ \t]*)(\d{1,9})([.)])(?=[ \t]+|$)/.exec(line);
      if (
        sibling &&
        sibling[3] === parentMarker[3] &&
        indentationColumn(sibling[1]!) === parentMarkerColumn &&
        Number.parseInt(sibling[2]!, 10) > 1
      ) {
        const markerFrom = lineFrom + sibling[1]!.length;
        edits.push({
          from: markerFrom,
          to: markerFrom + sibling[2]!.length,
          replacement: "1",
        });
      }
    }
    if (lineEnd < 0) break;
    lineFrom = lineEnd + 1;
  }
  if (edits.length === 0) return undefined;

  const originalInput = new StringSourceInput(sourceText);
  const protectedRanges: Array<{ readonly from: number; readonly to: number }> = [];
  const collectProtectedRanges = (node: SyntaxNode): void => {
    if (/(?:code|html)/i.test(node.type.name)) protectedRanges.push({ from: node.from, to: node.to });
    for (let child = node.firstChild; child; child = child.nextSibling) collectProtectedRanges(child);
  };
  collectProtectedRanges(parser.parse(originalInput).topNode);
  const safeEdits = edits.filter((edit) =>
    !protectedRanges.some((range) => range.from <= edit.from && edit.from < range.to),
  );
  if (safeEdits.length === 0) return undefined;
  const normalizedPositions: number[] = [];
  for (let offset = 0; offset < raw.length; offset += 1) {
    normalizedPositions.push(sourceRange(mapping, lineStart + offset, lineStart + offset + 1).from);
    if (raw[offset] === "\r" && raw[offset + 1] === "\n") offset += 1;
  }

  const transformedCharacters: string[] = [];
  const transformedPositions: number[] = [];
  const appendOriginal = (from: number, to: number): void => {
    transformedCharacters.push(sourceText.slice(from, to));
    for (let offset = from; offset < to; offset += 1) transformedPositions.push(normalizedPositions[offset]!);
  };
  const appendReplacement = (replacement: string, sourceOffset: number): void => {
    transformedCharacters.push(replacement);
    const mappedOffset = normalizedPositions[sourceOffset] ?? inputRange.from;
    for (let offset = 0; offset < replacement.length; offset += 1) transformedPositions.push(mappedOffset);
  };
  let cursor = 0;
  for (const edit of safeEdits) {
    appendOriginal(cursor, edit.from);
    appendReplacement(edit.replacement, edit.from);
    cursor = edit.to;
  }
  appendOriginal(cursor, sourceText.length);
  const transformedText = transformedCharacters.join("");
  if (transformedText === sourceText) return undefined;

  const input = new StringSourceInput(transformedText);
  const mapOffset = (offset: number): number => {
    if (offset <= 0) return transformedPositions[0] ?? inputRange.from;
    if (offset >= transformedPositions.length) return inputRange.to;
    return transformedPositions[offset]!;
  };
  const recoveredMapping: NativeNestedBlockSnapshotMapping = {
    ...mapping,
    input,
    mapOffset,
    mapRange: (from, to) => ({ from: mapOffset(from), to: mapOffset(to) }),
    knownListLoosenessForNode: undefined,
    presentationInput: input,
    recoveryRootRange: inputRange,
    markListIndentationRecoveryContent: false,
  };
  const parsed = parser.parse(input);
  const recoveredList = parsed.topNode.firstChild;
  if (
    !recoveredList ||
    recoveredList.type.name !== "OrderedList" ||
    recoveredList.nextSibling
  ) {
    return undefined;
  }

  const sourceMeta = sourceBlock.payload.meta as {
    formatAnticipation?: FormatAnticipationConfig;
    mathEnabled?: boolean;
    trustedMdxSource?: boolean;
  } | undefined;
  const recoveredBlock: Block = {
    id: `${parentListId}::list-indentation-recovery:${itemIdentity.semanticChildIndex}`,
    type: "list",
    isFinalized: sourceBlock.isFinalized,
    payload: {
      raw: mapping.source.read(inputRange.from, inputRange.to),
      range: inputRange,
      meta: {
        listIndentationRecovery: true,
        ...(sourceMeta?.formatAnticipation !== undefined ? { formatAnticipation: sourceMeta.formatAnticipation } : {}),
        ...(sourceMeta?.mathEnabled !== undefined ? { mathEnabled: sourceMeta.mathEnabled } : {}),
        ...(sourceMeta?.trustedMdxSource === true ? { trustedMdxSource: true } : {}),
      },
    },
  };
  const identityForRecoveredChild: NativeNestedChildIdentityFactory = (
    _recoveredParentId,
    recoveredParent,
    _child,
    childIndex,
    role,
    defaultId,
  ) => {
    if (recoveredParent === recoveredList && role === "item") {
      const semanticChildIndex = itemIdentity.semanticChildIndex + childIndex;
      return {
        id: childIndex === 0 ? itemIdentity.id : `${parentListId}::item:${semanticChildIndex}`,
        semanticChildIndex,
      };
    }
    return { id: defaultId, semanticChildIndex: childIndex };
  };
  // Native leaf owners are bound to the original parser tree, so lower this remapped tree generically.
  const prepared = lowerNestedBlockSnapshot(
    recoveredBlock,
    parsed.topNode,
    recoveredMapping,
    inlineParser,
    parser,
    streamingInline,
    undefined,
    identityForRecoveredChild,
    false,
  );
  return prepared.children[0]?.type === "list" ? prepared.children[0].children ?? [] : undefined;
}

const LIST_INDENTATION_INLINE_PARSE_PREFIX = "t3-markdown-inline-prefix:";

function recoverListIndentationCode(
  node: SyntaxNode,
  parent: SyntaxNode,
  id: string,
  sourceBlock: Block,
  mapping: NativeNestedBlockSnapshotMapping,
  inlineParser: InlineParser,
  parser: MarkdownParser,
  streamingInline: ((text: string) => InlineNode[]) | undefined,
): PreparedNestedSnapshot | undefined {
  if (
    parent.type.name !== "ListItem" ||
    (node.type.name !== "CodeBlock" && node.type.name !== "IndentedCode")
  ) {
    return undefined;
  }
  const range = sourceRange(mapping, node.from, node.to);
  const parentStart = sourceRange(mapping, parent.from, parent.from).from;
  if (lineStartAt(mapping.source, range.from) !== lineStartAt(mapping.source, parentStart)) return undefined;

  const extracted = extractLezerCodeDetailed(node, mapping.input, mapping, true);
  const positions = extracted.sourcePositions;
  if (!positions || !/^[\t ]/.test(extracted.code)) return undefined;
  const leading = extracted.code.length - extracted.code.trimStart().length;
  const trailing = extracted.code.trimEnd().length;
  const value = extracted.code.slice(leading, trailing);
  if (!value) return undefined;
  const valuePositions = positions.slice(leading, trailing);
  const prefix = LIST_INDENTATION_INLINE_PARSE_PREFIX;
  const input = new StringSourceInput(`${prefix}${value}`);
  const valueStart = valuePositions[0] ?? range.from;
  const mapOffset = (offset: number): number => {
    if (offset <= prefix.length) return valueStart;
    const valueOffset = offset - prefix.length;
    return valueOffset < valuePositions.length ? valuePositions[valueOffset]! : range.to;
  };
  const recoveredMapping: NativeNestedBlockSnapshotMapping = {
    ...mapping,
    input,
    mapOffset,
    mapRange: (from, to) => ({ from: mapOffset(from), to: mapOffset(to) }),
    knownListLoosenessForNode: undefined,
    presentationInput: input,
    presentationPrefix: prefix,
    recoveryRootRange: range,
  };
  const sourceMeta = sourceBlock.payload.meta as {
    formatAnticipation?: FormatAnticipationConfig;
    mathEnabled?: boolean;
    trustedMdxSource?: boolean;
  } | undefined;
  const recoveryMeta: NonNullable<Block["payload"]["meta"]> = {
    listIndentationRecovery: true,
    ...(sourceMeta?.formatAnticipation !== undefined ? { formatAnticipation: sourceMeta.formatAnticipation } : {}),
    ...(sourceMeta?.mathEnabled !== undefined ? { mathEnabled: sourceMeta.mathEnabled } : {}),
    ...(sourceMeta?.trustedMdxSource === true ? { trustedMdxSource: true } : {}),
  };
  const recoveredBlock: Block = {
    id,
    type: "list",
    isFinalized: sourceBlock.isFinalized,
    payload: {
      raw: mapping.source.read(range.from, range.to),
      range,
      meta: recoveryMeta,
    },
  };
  const recovered = lowerNestedBlockSnapshot(
    recoveredBlock,
    parser.parse(input).topNode,
    recoveredMapping,
    inlineParser,
    parser,
    streamingInline,
    undefined,
    undefined,
    false,
  );
  const firstParagraph = recovered.children[0];
  const firstParagraphBlock = firstParagraph?.props?.block as Block | undefined;
  const firstParagraphText = firstParagraph?.props?.text;
  const firstParagraphPositions = firstParagraphBlock?.payload.meta?.inlineSourcePositions;
  if (
    firstParagraph?.type === "paragraph" &&
    firstParagraphBlock &&
    typeof firstParagraphText === "string" &&
    Array.isArray(firstParagraphPositions) &&
    firstParagraphPositions.length === firstParagraphText.length
  ) {
    firstParagraphBlock.payload.meta = {
      ...firstParagraphBlock.payload.meta,
      listIndentationRecoveryContent: true,
      inlineSourceText: firstParagraphText,
    };
  }
  return recovered.children.length > 0 ? recovered : undefined;
}
