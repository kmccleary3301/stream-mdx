import type { BlockContext, Element, MarkdownConfig } from "@lezer/markdown";

// Lezer's native Type 6/7 start grammar. Only their blank-line terminator differs:
// Line.next already excludes every owning list/quote marker, unlike Line.text.
const htmlBlockTagStart = /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)/i;
const htmlCompleteTag = /^(?:<\/[a-z][\w-]*\s*>|<[a-z][\w-]*(\s+[a-z:_][\w-.]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*>)\s*$/i;

/** CommonMark block rules missing from Lezer's container HTML, empty-item, and tab-heading parsing. */
export function createBlockCompatibilityExtension(): MarkdownConfig {
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
        if (/^<(?:script|pre|style|textarea)(?:\s|>|$)/i.test(rest)) return false;
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
    }, {
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
