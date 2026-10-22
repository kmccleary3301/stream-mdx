declare const __STREAM_MDX_COUNTERS__: boolean | undefined;
import type { SyntaxNode, Tree } from "@lezer/common";
import type { MarkdownParser } from "@lezer/markdown";
import type { SourceSnapshot } from "@stream-mdx/core";
import { NativeMarkdownInput } from "./native-markdown-input";
import {
  NativeContainerWindowCache,
  lastPhysicalLineStart,
  lineEndAt,
  lineStartAt,
  type NativeContainerCodeOpening,
  type NativeContainerContextLine,
  type NativeContainerMarkerAnchor,
  type NativeContainerWindow,
  type NativeContainerWindowFrame,
} from "./native-container-window";

export type NativeContainerRootName = "BulletList" | "OrderedList" | "Blockquote";
export type NativeContainerClosure = "open" | "closed" | "finalized";
export interface NativeContainerTailDiagnosticCounters {
  recordPrefixComparisons?(count?: number, stage?: "engine"): void;
}

export interface NativeContainerListProperties {
  readonly pathIndex: number;
  readonly typeName: "BulletList" | "OrderedList";
  readonly orderedStart?: number;
  readonly markerFamily: string;
  readonly loose: boolean;
}

interface NativeContainerFrame extends NativeContainerWindowFrame {
  readonly sourceFrontier: number;
  readonly activeChildSourceEnd: number;
  readonly activeListItemContentEnd?: number;
  readonly nextChildIndex: number;
  readonly listProperties?: NativeContainerListProperties;
}

export interface NativeContainerTailState {
  readonly ownerStart: number;
  readonly ownerType: NativeContainerRootName;
  readonly inputGeneration: number;
  readonly sourceLength: number;
  readonly tailFrom: number;
  readonly phase: NativeContainerClosure;
  readonly activeLeafType?: string;
  readonly listProperties: readonly NativeContainerListProperties[];
  readonly frames: readonly NativeContainerWindowFrame[];
}

export interface NativeContainerTailChange {
  readonly tree: Tree;
  readonly rootNode: SyntaxNode;
  readonly leafNode: SyntaxNode;
  readonly window: NativeContainerWindow;
  readonly frames: readonly NativeContainerWindowFrame[];
  readonly pathNodes: readonly SyntaxNode[];
  readonly sourceRange: { readonly from: number; readonly to: number };
  readonly sourceAppend: string;
  readonly closure: NativeContainerClosure;
  readonly codeOpening?: NativeContainerCodeOpening;
  readonly tableContextLines: readonly NativeContainerContextLine[];
  readonly listProperties: readonly NativeContainerListProperties[];
  readonly changedCodeNodes: readonly SyntaxNode[];
}

interface ActivePath {
  readonly nodes: readonly SyntaxNode[];
  readonly frames: readonly NativeContainerFrame[];
  readonly leaf: SyntaxNode;
}

const CONTAINER_TYPES = new Set(["BulletList", "OrderedList", "ListItem", "EmptyListItem", "Blockquote"]);
const OMITTED_CHILDREN = new Set(["ListMark", "QuoteMark", "LinkReference"]);
const LIST_ITEMS = new Set(["ListItem", "EmptyListItem"]);
const BLOCK_CONTEXT_TYPES = new Set(["Paragraph", "Task"]);
const LIST_BLANK_GAP = /\r?\n[ >\t]*\r?\n/;

// Native container ranges stop before their terminal EOL; CRLF is one terminator too.
function hasSourceAfterNativeContainer(source: SourceSnapshot, to: number): boolean {
  const remaining = source.length - to;
  if (remaining <= 1) return false;
  if (remaining === 2 && source.read(to, source.length) === "\r\n") return false;
  return true;
}
function hasNonWhitespaceAfterNativeList(source: SourceSnapshot, from: number): boolean {
  let cursor = Math.max(0, Math.min(source.length, from));
  while (cursor < source.length) {
    const end = Math.min(source.length, cursor + 128);
    if (/[^ \t\r\n]/.test(source.read(cursor, end))) return true;
    cursor = end;
  }
  return false;
}




function isRootName(name: string): name is NativeContainerRootName {
  return name === "BulletList" || name === "OrderedList" || name === "Blockquote";
}

function frameKind(node: SyntaxNode): NativeContainerWindowFrame["kind"] | undefined {
  if (node.type.name === "BulletList" || node.type.name === "OrderedList") return "list";
  if (LIST_ITEMS.has(node.type.name)) return "item";
  if (node.type.name === "Blockquote") return "quote";
  return undefined;
}

function isSemanticChildType(parentName: string, childName: string | undefined): boolean {
  if (childName === undefined) return false;
  if (parentName === "BulletList" || parentName === "OrderedList") return LIST_ITEMS.has(childName);
  return !OMITTED_CHILDREN.has(childName);
}

function isSemanticChild(parent: SyntaxNode, child: SyntaxNode): boolean {
  return isSemanticChildType(parent.type.name, child.type.name);
}

function sameNativeSyntaxNode(left: SyntaxNode, right: SyntaxNode): boolean {
  return left.type === right.type && left.from === right.from && left.to === right.to;
}

function activeSemanticPathNodes(root: SyntaxNode): SyntaxNode[] {
  const nodes = [root];
  let node = root;
  while (frameKind(node) !== undefined) {
    let child = node.lastChild;
    while (child && !isSemanticChild(node, child)) child = child.prevSibling;
    if (!child) break;
    nodes.push(child);
    node = child;
  }
  return nodes;
}

function semanticIndex(parent: SyntaxNode, selected: SyntaxNode): number {
  let index = 0;
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (sameNativeSyntaxNode(child, selected)) return index;
    if (isSemanticChild(parent, child)) index += 1;
  }
  return index;
}


function semanticSiblingOffset(parent: SyntaxNode, selected: SyntaxNode, anchor: SyntaxNode): number | undefined {
  let selectedIndex: number | undefined;
  let anchorIndex: number | undefined;
  let index = 0;
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (sameNativeSyntaxNode(child, selected)) selectedIndex = index;
    if (sameNativeSyntaxNode(child, anchor)) anchorIndex = index;
    if (isSemanticChild(parent, child)) index += 1;
  }
  return selectedIndex === undefined || anchorIndex === undefined ? undefined : selectedIndex - anchorIndex;
}

function semanticChildrenAfterSourceEndBefore(
  parent: SyntaxNode,
  selected: SyntaxNode,
  sourceEnd: number,
  mapping: NativeContainerWindow["mapping"],
): number {
  let index = 0;
  for (let child = parent.firstChild; child && !sameNativeSyntaxNode(child, selected); child = child.nextSibling) {
    if (!isSemanticChild(parent, child)) continue;
    if (mapping.mapRange(child.from, child.to).from >= sourceEnd) index += 1;
  }
  return index;
}

function priorNativeChild(
  parent: SyntaxNode,
  prior: NativeContainerFrame,
  mapping: NativeContainerWindow["mapping"],
): SyntaxNode | undefined {
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.type.name !== prior.activeChildTypeName) continue;
    if (mapping.mapRange(child.from, child.to).from === prior.sourceFrontier) return child;
  }
  return undefined;
}

interface DescendantQuoteMarkerContext {
  readonly lines: readonly { readonly from: number; readonly to: number }[];
  readonly markers: readonly NativeContainerMarkerAnchor[];
}

function descendantQuoteMarkerContext(
  nodes: readonly SyntaxNode[],
  frameIndex: number,
  source: SourceSnapshot,
  mapping: NativeContainerWindow["mapping"],
): DescendantQuoteMarkerContext {
  const lines: Array<{ readonly from: number; readonly to: number }> = [];
  const markers: NativeContainerMarkerAnchor[] = [];
  const addLine = (physicalFrom: number): void => {
    const from = lineStartAt(source, physicalFrom);
    if (!lines.some((line) => line.from === from)) lines.push({ from, to: lineEndAt(source, from) });
  };
  for (let index = frameIndex + 1; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (node.type.name === "BulletList" || node.type.name === "OrderedList") {
      let firstItem: SyntaxNode | undefined;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (LIST_ITEMS.has(child.type.name)) {
          firstItem = child;
          break;
        }
      }
      const activeItem = nodes[index + 1];
      for (const item of [firstItem, activeItem && LIST_ITEMS.has(activeItem.type.name) ? activeItem : undefined]) {
        if (item) addLine(mapping.mapRange(item.from, item.to).from);
      }
    } else if (node.type.name === "FencedCode") {
      const marker = node.getChild("CodeMark");
      if (marker) addLine(mapping.mapRange(marker.from, marker.to).from);
    } else if (node.type.name === "CodeBlock") {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.type.name !== "CodeText") continue;
        addLine(mapping.mapRange(child.from, child.to).from);
        break;
      }
    }
  }
  if (lines.length > 0) {
    for (let index = frameIndex + 1; index < nodes.length; index += 1) {
      for (let sibling = nodes[index]!.prevSibling; sibling?.type.name === "QuoteMark"; sibling = sibling.prevSibling) {
        const range = mapping.mapRange(sibling.from, sibling.to);
        if (!lines.some((line) => range.from >= line.from && range.from < line.to)) continue;
        if (!markers.some((marker) => marker.from === range.from)) {
          markers.push({ typeName: "QuoteMark", from: range.from, to: range.to });
        }
      }
    }
  }
  return { lines: Object.freeze(lines), markers: Object.freeze(markers) };
}

function directQuoteMarkers(
  node: SyntaxNode,
  mapping: NativeContainerWindow["mapping"],
  context: DescendantQuoteMarkerContext,
): {
  readonly first?: NativeContainerMarkerAnchor;
  readonly last?: NativeContainerMarkerAnchor;
  readonly context: readonly NativeContainerMarkerAnchor[];
} {
  let first: NativeContainerMarkerAnchor | undefined;
  let last: NativeContainerMarkerAnchor | undefined;
  const contextMarkers: NativeContainerMarkerAnchor[] = [];
  const appendContext = (marker: NativeContainerMarkerAnchor): void => {
    if (!contextMarkers.some((candidate) => candidate.from === marker.from)) contextMarkers.push(marker);
  };
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.type.name !== "QuoteMark") continue;
    const range = mapping.mapRange(child.from, child.to);
    const marker = { typeName: "QuoteMark" as const, from: range.from, to: range.to };
    if (!first) first = marker;
    last = marker;
    if (context.lines.some((line) => range.from >= line.from && range.from < line.to)) appendContext(marker);
  }
  for (const marker of context.markers) appendContext(marker);
  return { first, last, context: Object.freeze(contextMarkers) };
}


function publicFrame(frame: NativeContainerFrame): NativeContainerWindowFrame {
  const {
    activeChildTypeName: _activeChildTypeName,
    activeListItemContentEnd: _activeListItemContentEnd,
    contextQuoteMarkers: _contextQuoteMarkers,
    firstContextLineComplete: _firstContextLineComplete,
    ...visible
  } = frame;
  void _activeChildTypeName;
  void _activeListItemContentEnd;
  void _contextQuoteMarkers;
  void _firstContextLineComplete;
  return Object.freeze(visible);
}

function childrenOf(parent: SyntaxNode): SyntaxNode[] {
  const children: SyntaxNode[] = [];
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (isSemanticChild(parent, child)) children.push(child);
  }
  return children;
}

function markerForItem(item: SyntaxNode, mapRange: (from: number, to: number) => { from: number; to: number }): NativeContainerMarkerAnchor | undefined {
  const mark = item.getChild("ListMark");
  if (!mark) return undefined;
  const range = mapRange(mark.from, mark.to);
  return { typeName: "ListMark", from: range.from, to: range.to };
}
function listItemContentEnd(
  item: SyntaxNode,
  mapRange: (from: number, to: number) => { readonly from: number; readonly to: number },
): number {
  const marker = item.getChild("ListMark");
  let end = marker ? mapRange(marker.from, marker.to).to : mapRange(item.from, item.to).from;
  for (let child = item.firstChild; child; child = child.nextSibling) {
    if (OMITTED_CHILDREN.has(child.type.name)) continue;
    end = mapRange(child.from, child.to).to;
  }
  return end;
}




function firstContextNode(node: SyntaxNode): SyntaxNode | undefined {
  let current = node;
  while (true) {
    if (BLOCK_CONTEXT_TYPES.has(current.type.name)) return current;
    let child = current.firstChild;
    if (current.type.name === "BulletList" || current.type.name === "OrderedList") {
      while (child && !LIST_ITEMS.has(child.type.name)) child = child.nextSibling;
    } else if (LIST_ITEMS.has(current.type.name) || current.type.name === "Blockquote") {
      while (child && (child.type.name === "ListMark" || child.type.name === "QuoteMark")) child = child.nextSibling;
    } else {
      return undefined;
    }
    if (!child) return undefined;
    current = child;
  }
}

function contextLine(
  source: SourceSnapshot,
  mapping: NativeContainerWindow["mapping"],
  node: SyntaxNode,
): NativeContainerContextLine | undefined {
  const physical = mapping.mapRange(node.from, node.to);
  const from = lineStartAt(source, physical.from);
  const to = lineEndAt(source, from);
  if (to <= from) return undefined;
  return Object.freeze({ from, to, text: source.read(from, to) });
}
function refreshIncompleteContextLines(
  source: SourceSnapshot,
  frames: readonly NativeContainerFrame[],
): readonly NativeContainerFrame[] {
  let refreshedFrames: NativeContainerFrame[] | undefined;
  let refreshedLines: Map<number, NativeContainerContextLine> | undefined;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!;
    const line = frame.firstContextLine;
    let refreshedFrame = frame;
    if (line && frame.firstContextLineComplete !== true && line.to < source.length) {
      refreshedLines ??= new Map<number, NativeContainerContextLine>();
      let refreshedLine = refreshedLines.get(line.from);
      if (!refreshedLine) {
        const lineEnd = lineEndAt(source, line.from);
        const complete = lineEnd < source.length;
        refreshedLine = Object.freeze({
          from: line.from,
          to: complete ? lineEnd : source.length,
          text: complete ? source.read(line.from, lineEnd) : line.text,
        });
        refreshedLines.set(line.from, refreshedLine);
      }
      const complete = refreshedLine.to < source.length;
      if (refreshedLine.to !== line.to || refreshedLine.text !== line.text
        || complete !== frame.firstContextLineComplete) {
        refreshedFrame = {
          ...frame,
          firstContextLine: refreshedLine,
          firstContextLineComplete: complete,
        };
      }
    }
    if (refreshedFrame !== frame) {
      refreshedFrames ??= frames.slice(0, index);
    }
    if (refreshedFrames) refreshedFrames.push(refreshedFrame);
  }
  return refreshedFrames ?? frames;
}

function listProperties(
  node: SyntaxNode,
  pathIndex: number,
  source: SourceSnapshot,
  mapping: NativeContainerWindow["mapping"],
  previous?: NativeContainerListProperties,
  actualChildren?: readonly SyntaxNode[],
  prefixLength = 0,
  previousChildEnd?: number,
): NativeContainerListProperties {
  const firstItem = childrenOf(node)[0];
  const firstMarker = firstItem ? markerForItem(firstItem, mapping.mapRange) : undefined;
  const markerFamily = previous?.markerFamily ?? (firstMarker ? source.read(firstMarker.from, firstMarker.to) : "");
  const parsedStart = node.type.name === "OrderedList" && markerFamily.length > 0
    ? Number.parseInt(markerFamily, 10)
    : undefined;
  let loose = previous?.loose ?? false;
  let priorEnd = previousChildEnd;
  let inspectedFirstChild = true;
  if (!loose) {
    const inspectedChildren = actualChildren ?? childrenOf(node);
    for (const child of inspectedChildren) {
      if (actualChildren && child.from < prefixLength) continue;
      const range = mapping.mapRange(child.from, child.to);
      if (inspectedFirstChild && priorEnd !== undefined && range.from < priorEnd) priorEnd = undefined;
      inspectedFirstChild = false;
      if (priorEnd !== undefined && LIST_BLANK_GAP.test(source.read(priorEnd, range.from))) {
        loose = true;
        break;
      }
      priorEnd = listItemContentEnd(child, mapping.mapRange);
      let priorBlockEnd: number | undefined;
      for (let nested = child.firstChild; nested; nested = nested.nextSibling) {
        if (OMITTED_CHILDREN.has(nested.type.name)) continue;
        const nestedRange = mapping.mapRange(nested.from, nested.to);
        if (priorBlockEnd !== undefined && LIST_BLANK_GAP.test(source.read(priorBlockEnd, nestedRange.from))) {
          loose = true;
          break;
        }
        priorBlockEnd = nestedRange.to;
      }
      if (loose) break;
    }
  }
  return Object.freeze({
    pathIndex,
    typeName: node.type.name as "BulletList" | "OrderedList",
    ...((previous?.orderedStart ?? (Number.isFinite(parsedStart) ? parsedStart : undefined)) === undefined
      ? {}
      : { orderedStart: previous?.orderedStart ?? parsedStart }),
    markerFamily,
    loose,
  });
}

function deriveActivePath(
  root: SyntaxNode,
  source: SourceSnapshot,
  window: NativeContainerWindow,
  previousFrames: readonly NativeContainerFrame[],
  initialOffset?: number,
): ActivePath {
  const nodes = activeSemanticPathNodes(root);
  let leafIndex = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    if (frameKind(nodes[index]!) !== undefined) leafIndex = index + 1;
  }
  const leaf = nodes[Math.min(leafIndex, nodes.length - 1)] ?? root;
  const frames: NativeContainerFrame[] = [];
  for (let index = 0; index < leafIndex; index += 1) {
    const node = nodes[index]!;
    const kind = frameKind(node);
    if (!kind) continue;
    const selected = nodes[index + 1];
    const parentRange = window.mapping.mapRange(node.from, node.to);
    const priorCandidate = previousFrames[frames.length];
    const prior = priorCandidate
      && priorCandidate.typeName === node.type.name
      && priorCandidate.parentFrom === parentRange.from
      ? priorCandidate
      : undefined;
    const selectedRange = selected
      ? window.mapping.mapRange(selected.from, selected.to)
      : { from: parentRange.to, to: parentRange.to };
    const actualChildren = childrenOf(node).filter((child) => child.from >= window.prefixLength);
    const selectedIsActual = selected !== undefined && selected.from >= window.prefixLength;
    const priorActiveChild = prior ? priorNativeChild(node, prior, window.mapping) : undefined;
    const priorActiveChildIsPresent = priorActiveChild !== undefined;
    const priorChildAdvance = prior
      && isSemanticChildType(node.type.name, prior.activeChildTypeName)
      && prior.nextChildIndex === prior.fromChild
      && prior.activeChildSourceEnd > prior.sourceFrontier
      && prior.activeChildSourceEnd <= selectedRange.from
      && !priorActiveChildIsPresent
      ? 1
      : 0;
    // Count only new siblings after the old leaf frontier; earlier completed children stay fixed.
    const priorSetextSiblingAdvance = prior
      && selected
      && isSemanticChildType(node.type.name, prior.activeChildTypeName)
      && (prior.activeChildTypeName === "SetextHeading1" || prior.activeChildTypeName === "SetextHeading2")
      && prior.nextChildIndex === prior.fromChild
      && prior.activeChildSourceEnd > prior.sourceFrontier
      && selectedRange.from >= prior.sourceFrontier
      && selectedRange.from < prior.activeChildSourceEnd
      && !priorActiveChildIsPresent
      ? semanticChildrenAfterSourceEndBefore(node, selected, prior.sourceFrontier, window.mapping)
      : 0;
    const selectedIndexBase = prior && priorActiveChildIsPresent
      ? prior.fromChild
      : (prior?.nextChildIndex ?? 0) + priorChildAdvance;
    const relativeSemanticIndex = selected && priorActiveChild
      ? semanticSiblingOffset(node, selected, priorActiveChild)
      : undefined;
    const selectedIndex = !selected
      ? 0
      : initialOffset !== undefined || !prior
        ? semanticIndex(node, selected)
        : relativeSemanticIndex !== undefined
          ? Math.max(0, prior.fromChild + relativeSemanticIndex)
          : priorSetextSiblingAdvance > 0
            ? selectedIndexBase + priorSetextSiblingAdvance
            : selectedRange.from >= prior.activeChildSourceEnd
              ? selectedIndexBase + semanticChildrenAfterSourceEndBefore(
                  node,
                  selected,
                  prior.activeChildSourceEnd,
                  window.mapping,
                )
              : prior.fromChild;
    let previousSiblingEnd = prior?.childToBeforeFrontier;
    const selectedActualIndex = selected && selectedIsActual
      ? actualChildren.findIndex((child) => sameNativeSyntaxNode(child, selected))
      : -1;
    if (selectedActualIndex > 0) {
      const before = actualChildren[selectedActualIndex - 1];
      if (before) {
        previousSiblingEnd = kind === "list"
          ? listItemContentEnd(before, window.mapping.mapRange)
          : window.mapping.mapRange(before.from, before.to).to;
      }
    } else if (selectedIsActual && prior && selectedRange.from > prior.sourceFrontier) {
      previousSiblingEnd = kind === "list"
        ? prior.activeListItemContentEnd ?? prior.activeChildSourceEnd
        : prior.activeChildSourceEnd;
    }
    let firstMarker = prior?.firstMarker;
    let activeMarker = prior?.activeMarker;
    let quoteMarker = prior?.quoteMarker;
    let firstQuoteMarker = prior?.firstQuoteMarker;
    let contextQuoteMarkers = prior?.contextQuoteMarkers;
    if (kind === "list") {
      const listChildren = childrenOf(node);
      firstMarker ??= listChildren[0] ? markerForItem(listChildren[0], window.mapping.mapRange) : undefined;
      const marker = selected ? markerForItem(selected, window.mapping.mapRange) : undefined;
      activeMarker = marker
        ? { ...marker, globalChildIndex: selectedIndex }
        : activeMarker;
    } else if (kind === "item") {
      activeMarker = markerForItem(node, window.mapping.mapRange) ?? activeMarker;
    } else {
      const markerContext = descendantQuoteMarkerContext(nodes, index, source, window.mapping);
      const markers = directQuoteMarkers(node, window.mapping, markerContext);
      firstQuoteMarker ??= markers.first;
      quoteMarker = markers.last ?? quoteMarker;
      if (markers.context.length > 0) contextQuoteMarkers = markers.context;
    }
    let firstContextLine = prior?.firstContextLine;
    let firstContextLineComplete = prior?.firstContextLineComplete;
    if (!firstContextLine) {
      const first = firstContextNode(node);
      if (first) {
        firstContextLine = contextLine(source, window.mapping, first);
        firstContextLineComplete = firstContextLine !== undefined && firstContextLine.to < source.length;
      }
    }
    let properties = prior?.listProperties;
    if (kind === "list") {
      properties = listProperties(
        node,
        frames.length,
        source,
        window.mapping,
        prior?.listProperties,
        actualChildren,
        window.prefixLength,
        previousSiblingEnd,
      );
    }
    const nextChildIndex = selected && selectedIsActual
      && selected.to < window.input.length - 1
      && isSemanticChild(node, selected)
      ? selectedIndex + 1
      : selectedIndex;
    frames.push({
      kind,
      typeName: node.type.name,
      activeChildTypeName: selected?.type.name,
      fromChild: selectedIndex,
      nextChildIndex,
      parentFrom: parentRange.from,
      parentTo: parentRange.to,
      sourceFrontier: selectedRange.from,
      activeChildSourceEnd: selectedRange.to,
      ...(kind === "list" && selected
        ? { activeListItemContentEnd: listItemContentEnd(selected, window.mapping.mapRange) }
        : {}),
      ...(previousSiblingEnd !== undefined ? { childToBeforeFrontier: previousSiblingEnd } : {}),
      ...(firstMarker ? { firstMarker } : {}),
      ...(activeMarker ? { activeMarker } : {}),
      ...(quoteMarker ? { quoteMarker } : {}),
      ...(firstQuoteMarker ? { firstQuoteMarker } : {}),
      ...(contextQuoteMarkers ? { contextQuoteMarkers } : {}),
      ...(firstContextLine ? { firstContextLine } : {}),
      ...(firstContextLine ? { firstContextLineComplete: firstContextLineComplete === true } : {}),
      ...(properties ? { listProperties: properties } : {}),
    });
  }
  return { nodes, frames, leaf };
}
function activeTailStart(
  source: SourceSnapshot,
  leaf: SyntaxNode,
  physicalRange: { readonly from: number; readonly to: number },
  fallbackTo: number,
  ownerStart: number,
  frames: readonly NativeContainerFrame[],
  paragraphOwnerSupported: boolean,
  codeContext?: NativeContainerCodeOpening,
  counters?: NativeContainerTailDiagnosticCounters,
): number {
  if ((leaf.type.name === "FencedCode" || leaf.type.name === "CodeBlock") && codeContext) {
    if (codeContext.openingContextText === "") return codeContext.openingLineFrom;
    return lastPhysicalLineStart(source, codeContext.openingLineTo, fallbackTo);
  }
  if (leaf.type.name === "Paragraph" || leaf.type.name === "Task") {
    if (!paragraphOwnerSupported) return lineStartAt(source, physicalRange.from);
    let paragraphContextStart: number | undefined;
    for (const frame of frames) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        counters?.recordPrefixComparisons?.(1, "engine");
      }
      const contextLine = frame.firstContextLine;
      if (contextLine
        && physicalRange.from >= contextLine.from
        && physicalRange.from < contextLine.to) {
        paragraphContextStart = contextLine.from;
        break;
      }
    }
    return paragraphContextStart !== undefined
      ? lastPhysicalLineStart(
          source,
          paragraphContextStart,
          Math.max(physicalRange.from, physicalRange.to - 1),
        )
      : lineStartAt(source, physicalRange.from);
  }
  return lastPhysicalLineStart(source, ownerStart, fallbackTo);
}
function openingLineHasEnding(source: SourceSnapshot, lineTo: number): boolean {
  if (lineTo >= source.length) return false;
  const ending = source.read(lineTo, Math.min(source.length, lineTo + 2));
  return ending.startsWith("\n") || (ending.startsWith("\r") && ending.length > 1);
}

function appendedOpeningLineFrontier(
  previousLineTo: number,
  previousSourceLength: number,
  sourceLength: number,
  appendedText: string,
): { readonly lineTo: number; readonly complete: boolean } {
  if (previousLineTo < previousSourceLength) {
    return {
      lineTo: previousLineTo,
      complete: appendedText.length > 0,
    };
  }
  for (let index = 0; index < appendedText.length; index += 1) {
    const unit = appendedText.charCodeAt(index);
    if (unit === 10) return { lineTo: previousSourceLength + index, complete: true };
    if (unit === 13) {
      return {
        lineTo: previousSourceLength + index,
        complete: index + 1 < appendedText.length,
      };
    }
  }
  return { lineTo: sourceLength, complete: false };
}

function codeOpening(
  source: SourceSnapshot,
  leaf: SyntaxNode,
  mapping: NativeContainerWindow["mapping"],
  previous?: NativeContainerCodeOpening,
  previousSourceLength = source.length,
  appendedText = "",
): NativeContainerCodeOpening | undefined {
  if (leaf.type.name === "FencedCode") {
    const marker = leaf.getChild("CodeMark");
    if (!marker) return undefined;
    const range = mapping.mapRange(marker.from, marker.to);
    const openingLineFrom = lineStartAt(source, range.from);
    const previousFenced = previous?.kind === "fenced" && previous.openingLineFrom === openingLineFrom
      ? previous
      : undefined;
    let openingLineTo: number;
    let openingContextText: string;
    if (previousFenced?.openingContextText) {
      openingLineTo = previousFenced.openingLineTo;
      openingContextText = previousFenced.openingContextText;
    } else if (previousFenced) {
      const frontier = appendedOpeningLineFrontier(
        previousFenced.openingLineTo,
        previousSourceLength,
        source.length,
        appendedText,
      );
      openingLineTo = frontier.lineTo;
      openingContextText = frontier.complete ? source.read(openingLineFrom, openingLineTo) : "";
    } else {
      openingLineTo = lineEndAt(source, openingLineFrom);
      openingContextText = openingLineHasEnding(source, openingLineTo)
        ? source.read(openingLineFrom, openingLineTo)
        : "";
    }
    return Object.freeze({
      kind: "fenced",
      openingLineFrom,
      openingTextFrom: openingLineFrom,
      openingLineTo,
      openingContextText,
    });
  }
  if (leaf.type.name === "CodeBlock") {
    let codeText: SyntaxNode | undefined;
    for (let child = leaf.firstChild; child; child = child.nextSibling) {
      if (child.type.name === "CodeText") {
        codeText = child;
        break;
      }
    }
    if (!codeText) return undefined;
    const textRange = mapping.mapRange(codeText.from, codeText.to);
    const openingLineFrom = lineStartAt(source, textRange.from);
    const openingTextFrom = textRange.from;
    const openingLineTo = lineEndAt(source, openingLineFrom);
    const openingContextText = source.read(openingLineFrom, openingLineTo);
    return Object.freeze({
      kind: "indented",
      openingLineFrom,
      openingTextFrom,
      openingLineTo,
      openingContextText,
    });
  }
  return undefined;
}


function tableContextLines(
  source: SourceSnapshot,
  table: SyntaxNode,
  mapping: NativeContainerWindow["mapping"],
): readonly NativeContainerContextLine[] {
  const lines: NativeContainerContextLine[] = [];
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.type.name !== "TableHeader" && child.type.name !== "TableDelimiter") continue;
    const range = mapping.mapRange(child.from, child.to);
    const from = lineStartAt(source, range.from);
    const to = lineEndAt(source, from);
    if (to <= from || lines.some((line) => line.from === from)) continue;
    lines.push(Object.freeze({ from, to, text: source.read(from, to) }));
  }
  return Object.freeze(lines);
}

function changedCodeNodes(leaf: SyntaxNode, prefixLength: number): readonly SyntaxNode[] {
  const nodes: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [leaf];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.to >= prefixLength && (node.type.name === "CodeText" || node.type.name === "CodeMark")) nodes.push(node);
    for (let child = node.firstChild; child; child = child.nextSibling) stack.push(child);
  }
  return Object.freeze(nodes);
}

function findContainer(tree: Tree, type: NativeContainerRootName): SyntaxNode | undefined {
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.type.name === type) return node;
  }
  return undefined;
}

function orderedListProperties(frames: readonly NativeContainerFrame[]): readonly NativeContainerListProperties[] {
  const lists: NativeContainerListProperties[] = [];
  for (const frame of frames) {
    if (frame.listProperties) lists.push(frame.listProperties);
  }
  return Object.freeze(lists);
}

export class NativeContainerTailParser {
  private readonly parser: MarkdownParser;
  private readonly document: object;
  private readonly inputGeneration: number;
  private readonly ownerStart: number;
  private readonly ownerType: NativeContainerRootName;
  private readonly paragraphOwnerSupported: boolean;
  private readonly counters?: NativeContainerTailDiagnosticCounters;
  private readonly windowCache = new NativeContainerWindowCache();
  private sourceLength: number;
  private tailFrom: number;
  private frames: readonly NativeContainerFrame[];
  private activeLeaf: SyntaxNode | undefined;
  private codeOpening: NativeContainerCodeOpening | undefined;
  private tableContext: readonly NativeContainerContextLine[] = Object.freeze([]);
  private phase: NativeContainerClosure = "open";

  private constructor(
    parser: MarkdownParser,
    document: object,
    inputGeneration: number,
    source: SourceSnapshot,
    root: SyntaxNode,
    sourceOffset: number,
    paragraphOwnerSupported: boolean,
    counters?: NativeContainerTailDiagnosticCounters,
  ) {
    this.parser = parser;
    this.document = document;
    this.inputGeneration = inputGeneration;
    this.ownerType = root.type.name as NativeContainerRootName;
    this.ownerStart = sourceOffset + root.from;
    this.paragraphOwnerSupported = paragraphOwnerSupported;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.counters = counters;
    }
    this.sourceLength = source.length;
    const identityMapping = {
      mapOffset: (offset: number) => sourceOffset + offset,
      mapRange: (from: number, to: number) => ({ from: sourceOffset + from, to: sourceOffset + to }),
    };
    const path = this.initialPath(root, source, identityMapping, sourceOffset);
    this.frames = path.frames;
    this.activeLeaf = path.leaf;
    this.codeOpening = codeOpening(source, path.leaf, {
      input: source,
      source,
      ...identityMapping,
    });
    this.tableContext = path.leaf.type.name === "Table"
      ? tableContextLines(source, path.leaf, { input: source, source, ...identityMapping })
      : Object.freeze([]);
    this.tailFrom = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? activeTailStart(
          source,
          path.leaf,
          identityMapping.mapRange(path.leaf.from, path.leaf.to),
          sourceOffset + root.to,
          this.ownerStart,
          path.frames,
          this.paragraphOwnerSupported,
          this.codeOpening,
          this.counters,
        )
      : activeTailStart(
          source,
          path.leaf,
          identityMapping.mapRange(path.leaf.from, path.leaf.to),
          sourceOffset + root.to,
          this.ownerStart,
          path.frames,
          this.paragraphOwnerSupported,
          this.codeOpening,
        );
    const hasSourceAfterRoot = this.ownerType === "BulletList" || this.ownerType === "OrderedList"
      ? hasNonWhitespaceAfterNativeList(source, sourceOffset + root.to)
      : hasSourceAfterNativeContainer(source, sourceOffset + root.to);
    if (hasSourceAfterRoot) this.phase = "closed";
  }

  static admit(
    parser: MarkdownParser,
    document: object,
    inputGeneration: number,
    source: SourceSnapshot,
    root: SyntaxNode,
    sourceOffset = 0,
    paragraphOwnerSupported = false,
    counters?: NativeContainerTailDiagnosticCounters,
  ): NativeContainerTailParser {
    if (!isRootName(root.type.name)) {
      throw new TypeError("Native container tail admits only native lists or blockquotes");
    }
    if (!Number.isSafeInteger(inputGeneration) || inputGeneration < 0) {
      throw new RangeError("Native container input generation must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0) {
      throw new RangeError("Native container source offset must be a non-negative safe integer");
    }
    if (sourceOffset + root.from < 0 || sourceOffset + root.to > source.length) {
      throw new RangeError("Native container range is outside the canonical source");
    }
    return typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? new NativeContainerTailParser(
          parser,
          document,
          inputGeneration,
          source,
          root,
          sourceOffset,
          paragraphOwnerSupported,
          counters,
        )
      : new NativeContainerTailParser(
          parser,
          document,
          inputGeneration,
          source,
          root,
          sourceOffset,
          paragraphOwnerSupported,
        );
  }

  get activeLeafNode(): SyntaxNode {
    if (!this.activeLeaf) throw new Error("Native container tail has no active leaf");
    return this.activeLeaf;
  }

  get state(): NativeContainerTailState {
    return Object.freeze({
      ownerStart: this.ownerStart,
      ownerType: this.ownerType,
      inputGeneration: this.inputGeneration,
      sourceLength: this.sourceLength,
      tailFrom: this.tailFrom,
      phase: this.phase,
      ...(this.activeLeaf ? { activeLeafType: this.activeLeaf.type.name } : {}),
      listProperties: orderedListProperties(this.frames),
      frames: Object.freeze(this.frames.map(publicFrame)),
    });
  }

  append(
    source: SourceSnapshot,
    appendedText: string,
    tailTo: number,
    finalized = false,
  ): NativeContainerTailChange | undefined {
    if (source.length < this.sourceLength || appendedText.length !== source.length - this.sourceLength) {
      throw new RangeError("Native container source must be an exact append-only suffix");
    }
    if (this.phase !== "open" && !finalized) return undefined;
    if (appendedText.length === 0 && !finalized && tailTo === this.sourceLength) return undefined;
    const contextFrames = refreshIncompleteContextLines(source, this.frames);
    const window = this.windowCache.create(
      this.document,
      this.inputGeneration,
      source,
      this.tailFrom,
      tailTo,
      contextFrames,
      this.codeOpening,
      this.tableContext,
    );
    if (!window) throw new Error("Native container marker context does not match its authored source");
    const tree = new NativeMarkdownInput(window.input).parse(this.parser);
    const rootNode = findContainer(tree, this.ownerType);
    if (!rootNode) throw new Error("Configured native parser did not preserve the active container in its bounded window");
    const path = deriveActivePath(rootNode, source, window, contextFrames);
    const range = window.mapping.mapRange(rootNode.from, rootNode.to);
    const hasSourceAfterRoot = this.ownerType === "BulletList" || this.ownerType === "OrderedList"
      ? hasNonWhitespaceAfterNativeList(source, range.to)
      : hasSourceAfterNativeContainer(source, tailTo)
        || hasSourceAfterNativeContainer(source, range.to);
    const closure: NativeContainerClosure = finalized
      ? "finalized"
      : hasSourceAfterRoot
        ? "closed"
        : "open";
    const nextCodeOpening = codeOpening(source, path.leaf, window.mapping, this.codeOpening, this.sourceLength, appendedText);
    const nextTableContext = path.leaf.type.name === "Table"
      ? tableContextLines(source, path.leaf, window.mapping)
      : Object.freeze([]);
    const sourceAppend = source.read(this.sourceLength, source.length);
    this.sourceLength = source.length;
    const leafRange = window.mapping.mapRange(path.leaf.from, path.leaf.to);
    this.tailFrom = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? activeTailStart(
          source,
          path.leaf,
          leafRange,
          Math.min(tailTo, source.length),
          this.ownerStart,
          path.frames,
          this.paragraphOwnerSupported,
          nextCodeOpening,
          this.counters,
        )
      : activeTailStart(
          source,
          path.leaf,
          leafRange,
          Math.min(tailTo, source.length),
          this.ownerStart,
          path.frames,
          this.paragraphOwnerSupported,
          nextCodeOpening,
        );
    this.frames = path.frames;
    this.activeLeaf = path.leaf;
    this.codeOpening = nextCodeOpening;
    this.tableContext = nextTableContext;
    this.phase = closure;
    return Object.freeze({
      tree,
      rootNode,
      leafNode: path.leaf,
      window,
      pathNodes: Object.freeze(path.nodes.slice()),
      frames: Object.freeze(path.frames.map(publicFrame)),
      sourceRange: Object.freeze(range),
      sourceAppend,
      closure,
      ...(nextCodeOpening ? { codeOpening: nextCodeOpening } : {}),
      tableContextLines: nextTableContext,
      listProperties: orderedListProperties(path.frames),
      changedCodeNodes: path.leaf.type.name === "FencedCode" || path.leaf.type.name === "CodeBlock"
        ? changedCodeNodes(path.leaf, window.prefixLength)
        : Object.freeze([]),
    });
  }

  finalize(source: SourceSnapshot, tailTo: number): NativeContainerTailChange | undefined {
    if (source.length !== this.sourceLength) {
      throw new RangeError("Append the latest canonical source before finalizing a native container");
    }
    if (this.phase === "finalized") return undefined;
    return this.append(source, "", tailTo, true);
  }

  clear(): void {
    this.windowCache.clear();
    this.frames = Object.freeze([]);
    this.tableContext = Object.freeze([]);
    this.codeOpening = undefined;
    this.activeLeaf = undefined;
    this.phase = "finalized";
  }

  private initialPath(
    root: SyntaxNode,
    source: SourceSnapshot,
    mapping: { mapOffset(offset: number): number; mapRange(from: number, to: number): { from: number; to: number } },
    sourceOffset: number,
  ): ActivePath {
    const nodes = activeSemanticPathNodes(root);
    let leafIndex = 0;
    for (let index = 0; index < nodes.length; index += 1) {
      if (frameKind(nodes[index]!) !== undefined) leafIndex = index + 1;
    }
    const leaf = nodes[Math.min(leafIndex, nodes.length - 1)] ?? root;
    const frames: NativeContainerFrame[] = [];
    for (let index = 0; index < leafIndex; index += 1) {
      const node = nodes[index]!;
      const kind = frameKind(node);
      if (!kind) continue;
      const selected = nodes[index + 1];
      const parentRange = mapping.mapRange(node.from, node.to);
      const selectedRange = selected
        ? mapping.mapRange(selected.from, selected.to)
        : { from: parentRange.to, to: parentRange.to };
      const children = childrenOf(node);
      const selectedIndex = selected ? semanticIndex(node, selected) : 0;
      let priorChild = selected?.prevSibling;
      while (priorChild && !isSemanticChild(node, priorChild)) priorChild = priorChild.prevSibling;
      const priorRange = priorChild ? mapping.mapRange(priorChild.from, priorChild.to) : undefined;
      const priorChildContentEnd = kind === "list" && priorChild
        ? listItemContentEnd(priorChild, mapping.mapRange)
        : priorRange?.to;
      let firstMarker: NativeContainerMarkerAnchor | undefined;
      let activeMarker: NativeContainerMarkerAnchor | undefined;
      let quoteMarker: NativeContainerMarkerAnchor | undefined;
      let firstQuoteMarker: NativeContainerMarkerAnchor | undefined;
      let contextQuoteMarkers: readonly NativeContainerMarkerAnchor[] | undefined;
      if (kind === "list") {
        firstMarker = children[0] ? markerForItem(children[0], mapping.mapRange) : undefined;
        activeMarker = selected ? markerForItem(selected, mapping.mapRange) : undefined;
      } else if (kind === "item") {
        activeMarker = markerForItem(node, mapping.mapRange);
      } else {
        const quoteMapping = { input: source, source, ...mapping };
        const markerContext = descendantQuoteMarkerContext(nodes, index, source, quoteMapping);
        const markers = directQuoteMarkers(node, quoteMapping, markerContext);
        firstQuoteMarker = markers.first;
        quoteMarker = markers.last;
        if (markers.context.length > 0) contextQuoteMarkers = markers.context;
      }
      const first = firstContextNode(node);
      const firstContextLine = first ? contextLine(source, { input: source, source, ...mapping }, first) : undefined;
      const properties = kind === "list"
        ? listProperties(node, frames.length, source, { input: source, source, ...mapping })
        : undefined;
      frames.push({
        kind,
        typeName: node.type.name,
        activeChildTypeName: selected?.type.name,
        fromChild: selectedIndex,
        nextChildIndex: selectedIndex + (selected && isSemanticChild(node, selected) && selected.to < root.to - 1 ? 1 : 0),
        parentFrom: parentRange.from,
        parentTo: parentRange.to,
        sourceFrontier: selectedRange.from,
        activeChildSourceEnd: selectedRange.to,
        ...(kind === "list" && selected
          ? { activeListItemContentEnd: listItemContentEnd(selected, mapping.mapRange) }
          : {}),
        ...(firstMarker ? { firstMarker } : {}),
        ...(activeMarker ? { activeMarker } : {}),
        ...(quoteMarker ? { quoteMarker } : {}),
        ...(firstQuoteMarker ? { firstQuoteMarker } : {}),
        ...(contextQuoteMarkers ? { contextQuoteMarkers } : {}),
        ...(firstContextLine ? { firstContextLine } : {}),
        ...(firstContextLine ? { firstContextLineComplete: firstContextLine.to < source.length } : {}),
        ...(priorChildContentEnd !== undefined ? { childToBeforeFrontier: priorChildContentEnd } : {}),
        ...(properties ? { listProperties: properties } : {}),
      });
    }
    return { nodes, frames, leaf };
  }
}
