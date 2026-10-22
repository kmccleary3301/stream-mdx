import type { BlockContext, Element, LeafBlock, LeafBlockParser, Line, MarkdownConfig } from "@lezer/markdown";
import { parseRestrictedTag, type RestrictedComponentDescriptor } from "./admission";

// Lezer's native Type 6/7 start grammar. Only their blank-line terminator differs:
// Line.next already excludes every owning list/quote marker, unlike Line.text.
const htmlBlockTagStart = /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)/i;
const htmlCompleteTag = /^(?:<\/[a-z][\w-]*\s*>|<[a-z][\w-]*(\s+[a-z:_][\w-.]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*>)\s*$/i;

const htmlTypeOneStart = /^<(?:script|pre|style|textarea)(?:\s|>|$)/i;

type RegisteredComponents = () => ReadonlyMap<string, RestrictedComponentDescriptor> | undefined;
type HeaderScan = {
  parts: string[];
  partIndex: number;
  partOffset: number;
  position: number;
  quote: string | null;
  braceDepth: number;
  escaped: boolean;
  end: number | null;
};
type PendingHeader = {
  readonly name: string;
  readonly scan: HeaderScan;
  readonly markers: Element[];
  readonly depth: number;
  readonly line: Line;
  readonly start: number;
};
type BlockParser = NonNullable<MarkdownConfig["parseBlock"]>[number];


function createHeaderScan(source: string): HeaderScan {
  const scan: HeaderScan = {
    parts: [source],
    partIndex: 0,
    partOffset: 0,
    position: 0,
    quote: null,
    braceDepth: 0,
    escaped: false,
    end: null,
  };
  advanceHeaderScan(scan);
  return scan;
}

function appendHeaderLine(scan: HeaderScan, line: string): void {
  if (scan.end !== null) return;
  scan.parts.push("\n", line);
  advanceHeaderScan(scan);
}

/** Advances over newly observed header bytes; unresolved headers cost linear time in their own bytes. */
function advanceHeaderScan(scan: HeaderScan): void {
  while (scan.partIndex < scan.parts.length) {
    const part = scan.parts[scan.partIndex];
    if (scan.partOffset === part.length) {
      scan.partIndex++;
      scan.partOffset = 0;
      continue;
    }
    const character = part[scan.partOffset++];
    scan.position++;
    if (scan.quote !== null) {
      if (scan.braceDepth > 0) {
        if (scan.escaped) {
          scan.escaped = false;
          continue;
        }
        if (character === "\\") {
          scan.escaped = true;
          continue;
        }
      }
      if (character === scan.quote) scan.quote = null;
      continue;
    }
    if (character === '"' || character === "'") scan.quote = character;
    else if (character === "{") scan.braceDepth++;
    else if (character === "}" && scan.braceDepth > 0) scan.braceDepth--;
    else if (character === ">" && scan.braceDepth === 0) {
      scan.end = scan.position;
      return;
    }
  }
}

function headerSource(scan: HeaderScan): string {
  const chunks: string[] = [];
  let remaining = scan.end ?? 0;
  for (const part of scan.parts) {
    if (remaining <= part.length) {
      chunks.push(part.slice(0, remaining));
      break;
    }
    chunks.push(part);
    remaining -= part.length;
  }
  return chunks.join("");
}

function isValidRegisteredOpening(name: string, scan: HeaderScan): boolean {
  if (scan.end === null) return false;
  const parsed = parseRestrictedTag(headerSource(scan));
  return parsed.ok && parsed.kind !== "close" && parsed.tagName === name;
}

class RegisteredHeaderLeafParser implements LeafBlockParser {
  private rejected = false;
  private observedLine: number;

  constructor(private readonly candidate: PendingHeader) {
    this.observedLine = candidate.start;
  }

  nextLine(cx: BlockContext, line: Line, leaf: LeafBlock): boolean {
    if (this.rejected) return false;
    const continuation = line as typeof line & { readonly depth: number; readonly markers: readonly Element[] };
    if (continuation.depth !== this.candidate.depth) {
      this.rejected = true;
      return false;
    }

    this.observedLine = cx.lineStart;
    appendHeaderLine(this.candidate.scan, line.text.slice(line.pos));
    if (this.candidate.scan.end === null) return false;
    if (!isValidRegisteredOpening(this.candidate.name, this.candidate.scan)) {
      this.rejected = true;
      return false;
    }

    const markedLeaf = leaf as LeafBlock & { readonly marks: Element[] };
    markedLeaf.marks.push(...continuation.markers);
    cx.nextLine();
    cx.addLeafElement(leaf, cx.elt("HTMLBlock", leaf.start, cx.prevLineEnd()));
    return true;
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    if (this.rejected) return false;
    // A closing `>` can look like a new quote to Lezer's paragraph interrupt
    // predicates, which run before leaf continuation. Validate it as header
    // syntax before allowing the native interrupt to claim the line.
    if (this.candidate.scan.end === null && cx.lineStart > this.observedLine) {
      if (this.nextLine(cx, this.candidate.line, leaf)) return true;
    }
    if (!isValidRegisteredOpening(this.candidate.name, this.candidate.scan)) return false;
    cx.addLeafElement(leaf, cx.elt("HTMLBlock", leaf.start, leaf.start + leaf.content.length));
    return true;
  }
}

function createRegisteredHeaderBlockParser(getRegisteredComponents: RegisteredComponents): BlockParser {
  const pendingHeaders = new WeakMap<BlockContext, PendingHeader>();
  return {
    name: "RegisteredComponentHeaderBoundary",
    before: "ContainerHTMLBlock",
    parse(cx, line) {
      if (line.indent >= line.baseIndent + 4 || line.next !== 60) return false;
      const components = getRegisteredComponents();
      if (!components || components.size === 0) return false;
      const source = line.text.slice(line.pos);
      if (htmlTypeOneStart.test(source) || htmlBlockTagStart.test(source)) return false;
      const name = /^<\s*([A-Za-z][\w-]*)/.exec(source)?.[1];
      if (!name || !components.has(name)) return false;
      const openingLine = line as typeof line & { readonly markers: readonly Element[] };

      const scan = createHeaderScan(source);
      if (scan.end !== null) {
        if (!isValidRegisteredOpening(name, scan)) return false;
        const from = cx.lineStart + line.pos;
        const markers = openingLine.markers.slice();
        cx.nextLine();
        cx.addElement(cx.elt("HTMLBlock", from, cx.prevLineEnd(), markers));
        return true;
      }

      pendingHeaders.set(cx, { name, scan, markers: openingLine.markers.slice(), depth: cx.depth, line, start: cx.lineStart });
      return false;
    },
    leaf(cx, leaf) {
      const candidate = pendingHeaders.get(cx);
      if (!candidate) return null;
      pendingHeaders.delete(cx);
      const markedLeaf = leaf as LeafBlock & { readonly marks: Element[] };
      markedLeaf.marks.push(...candidate.markers);
      const parser = new RegisteredHeaderLeafParser(candidate);
      return parser;
    },
  };
}


/** CommonMark block rules missing from Lezer's container HTML, empty-item, and tab-heading parsing. */
export function createBlockCompatibilityExtension(registeredComponents?: RegisteredComponents): MarkdownConfig {
  const activeEmptyItems = new WeakMap<BlockContext, Set<number>>();
  return {
    defineNodes: [{
      name: "EmptyListItem",
      composite(cx, line, value) {
        const target = line.baseIndent + value;
        const active = activeEmptyItems.get(cx);
        if (line.next === -1 && !active?.has(target)) return false;
        if (line.next !== -1 && line.indent < target) return false;
        if (line.next !== -1) active?.add(target);
        line.moveBaseColumn(target);
        return true;
      },
    }],
    parseBlock: [{
      name: "ContainerHTMLBlock",
      before: "HTMLBlock",
      parse(cx, line) {
        if (line.next !== 60) return false;
        const rest = line.text.slice(line.pos);
        // Type 1 remains literal through blank lines and belongs to its existing native parser.
        if (htmlTypeOneStart.test(rest)) return false;
        if (!htmlBlockTagStart.test(rest) && !htmlCompleteTag.test(rest)) return false;
        const from = cx.lineStart + line.pos;
        const depth = cx.depth;
        // Native Line.reset/readLine keep these fields on the same Line object.
        // They are omitted from Lezer's declarations, but preserve native marker ownership.
        const continuation = line as typeof line & { readonly depth: number; readonly markers: readonly Element[] };
        const marks: Element[] = [];
        while (cx.nextLine()) {
          if (continuation.depth < depth || line.pos === line.text.length) break;
          for (const mark of continuation.markers) marks.push(mark);
        }
        cx.addElement(cx.elt("HTMLBlock", from, cx.prevLineEnd(), marks));
        return true;
      },
    },
    ...(registeredComponents ? [createRegisteredHeaderBlockParser(registeredComponents)] : []),
    {
      name: "EmptyListItem",
      before: "BulletList",
      parse(cx, line) {
        if (line.indent >= line.baseIndent + 4) return false;
        const marker = line.text.slice(line.pos).match(/^(?:[-+*]|\d{1,9}[.)])[ \t]*$/);
        if (!marker) return false;
        const mark = marker[0].trimEnd();
        const ordered = /^\d/.test(mark);
        const listType = ordered ? "OrderedList" : "BulletList";
        if (cx.parentType().name !== listType) cx.startComposite(listType, line.basePos, mark.charCodeAt(mark.length - 1));
        const target = line.countIndent(line.pos + mark.length) + 1;
        let active = activeEmptyItems.get(cx);
        if (!active) activeEmptyItems.set(cx, active = new Set());
        active.delete(target);
        cx.startComposite("EmptyListItem", line.basePos, target - line.baseIndent);
        cx.addElement(cx.elt("ListMark", cx.lineStart + line.pos, cx.lineStart + line.pos + mark.length));
        line.moveBaseColumn(target);
        return null;
      },
    }, {
      name: "EmptyListItemOpeningLine",
      before: "IndentedCode",
      parse(cx, line) {
        if (cx.parentType().name !== "EmptyListItem" || line.next !== -1) return false;
        cx.nextLine();
        return true;
      },
    }, {
      name: "TabATXHeading",
      before: "ATXHeading",
      parse(cx, line) {
        if (line.indent >= line.baseIndent + 4) return false;
        const match = line.text.slice(line.pos).match(/^(#{1,6})\t/);
        if (!match) return false;
        const from = cx.lineStart + line.pos;
        const size = match[1].length;
        const end = line.text.length;
        const closing = line.text.slice(line.pos + size).match(/[ \t]+#+[ \t]*$/);
        const contentEnd = closing ? line.pos + size + (closing.index ?? 0) : end;
        const children = [cx.elt("HeaderMark", from, from + size),
          ...cx.parser.parseInline(line.text.slice(line.pos + size + 1, contentEnd), from + size + 1)];
        if (closing) children.push(cx.elt("HeaderMark", cx.lineStart + contentEnd, cx.lineStart + end));
        cx.addElement(cx.elt(`ATXHeading${size}`, from, cx.lineStart + end, children));
        cx.nextLine();
        return true;
      },
      endLeaf(_cx, line) {
        return line.indent < line.baseIndent + 4 && /^#{1,6}\t/.test(line.text.slice(line.pos));
      },
    }],
  };
}
