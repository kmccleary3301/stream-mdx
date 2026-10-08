import type { BlockContext, MarkdownConfig } from "@lezer/markdown";

/** CommonMark block rules missing from Lezer's built-in empty-item and tab-heading parsing. */
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
