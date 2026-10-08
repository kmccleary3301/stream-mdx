import type { SyntaxNode } from "@lezer/common";
import type { MarkdownParser } from "@lezer/markdown";
import { createBlockSnapshot, inlineNodesToPlainText } from "./block-snapshot";
import type { InlineParser } from "./inline-parser";
import { extractMixedContentSegments } from "./mixed-content";
import { normalizeFormatAnticipation, prepareInlineStreamingContent } from "./streaming/inline-streaming";
import type { Block, FormatAnticipationConfig, InlineNode, NodeSnapshot } from "./types";
import { parseCodeFenceInfo, removeHeadingMarkers } from "./utils";

/** Serializable container structure prepared by the owning engine, not by renderers. */
export interface PreparedNestedSnapshot {
  props: Record<string, unknown>;
  children: NodeSnapshot[];
}

export function prepareNestedBlockSnapshot(block: Block, inlineParser: InlineParser, parser: MarkdownParser, streamingInline?: (text: string) => InlineNode[]): PreparedNestedSnapshot {
  const source = block.payload.raw;
  const tree = parser.parse(source);
  const offset = block.payload.range?.from ?? 0;
  const meta = block.payload.meta as { formatAnticipation?: FormatAnticipationConfig; mathEnabled?: boolean } | undefined;
  const parseInline = (text: string): InlineNode[] => {
    if (block.isFinalized) return inlineParser.parse(text);
    if (streamingInline) return streamingInline(text);
    const formatAnticipation = meta?.formatAnticipation ?? { inline: true, mathInline: true, mathBlock: true, regex: true };
    const prepared = prepareInlineStreamingContent(text, { formatAnticipation, math: meta?.mathEnabled !== false });
    if (prepared.kind === "raw") return [{ kind: "text", text }];
    const append = normalizeFormatAnticipation(formatAnticipation).regex ? inlineParser.getRegexAnticipationAppend(text) : "";
    return inlineParser.parse(prepared.content + append, { cache: false });
  };
  const childrenOf = (node: SyntaxNode): SyntaxNode[] => {
    const children: SyntaxNode[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) children.push(child);
    return children;
  };
  // Lezer includes continuation quote marks in leaf ranges. Remove exactly those marks,
  // including every ancestor's mark on lazy continuation lines, rather than stripping text heuristically.
  const leafText = (node: SyntaxNode): string => {
    const marks: SyntaxNode[] = [];
    const visit = (child: SyntaxNode) => {
      if (child.type.name === "QuoteMark") marks.push(child);
      else for (const nested of childrenOf(child)) visit(nested);
    };
    visit(node);
    let result = "";
    let from = node.from;
    for (const mark of marks.sort((a, b) => a.from - b.from)) {
      result += source.slice(from, mark.from);
      from = mark.to;
      if (source[from] === " " || source[from] === "\t") from++;
    }
    return (result + source.slice(from, node.to)).split("\n").map((line) => line.trimStart()).join("\n");
  };
  const looseList = (node: SyntaxNode): boolean => {
    const items = childrenOf(node).filter((child) => child.type.name === "ListItem" || child.type.name === "EmptyListItem");
    const blankGap = (a: SyntaxNode, b: SyntaxNode) => /\n[ >\t]*\n/.test(source.slice(a.to, b.from));
    return items.some((item, i) => {
      if (i > 0 && blankGap(items[i - 1], item)) return true;
      const children = childrenOf(item).filter((child) => !["ListMark", "QuoteMark", "LinkReference"].includes(child.type.name));
      return children.some((child, j) => j > 0 && blankGap(children[j - 1], child));
    });
  };
  const build = (node: SyntaxNode, id: string, container: "list" | "blockquote"): NodeSnapshot | null => {
    const name = node.type.name;
    if (["QuoteMark", "ListMark", "LinkReference"].includes(name)) return null;
    const range = { from: offset + node.from, to: offset + node.to };
    const baseMeta: Record<string, unknown> = { sourceContainer: container };
    if (name === "BulletList" || name === "OrderedList") {
      const ordered = name === "OrderedList";
      const loose = looseList(node);
      const mark = node.firstChild?.getChild("ListMark");
      const start = ordered && mark ? Number.parseInt(source.slice(mark.from, mark.to), 10) : undefined;
      const props = { ordered, loose, start: start === 1 ? undefined : start };
      const children = childrenOf(node).filter((child) => child.type.name === "ListItem" || child.type.name === "EmptyListItem").map((item, index): NodeSnapshot => {
        const itemId = `${id}::item:${index}`;
        const content = childrenOf(item).filter((child) => !["ListMark", "QuoteMark", "LinkReference"].includes(child.type.name));
        const first = content[0];
        const primary = first && (first.type.name === "Paragraph" || first.type.name === "Task") ? first : undefined;
        const text = primary ? leafText(primary) : "";
        const task = primary?.type.name === "Task" ? text.match(/^\[([ xX])\][ \t]+/) : null;
        const primaryText = task ? text.slice(task[0].length) : text;
        const inline = parseInline(primaryText);
        const segments = primary ? extractMixedContentSegments(primaryText, undefined, parseInline) : [];
        const structured = segments.some((segment) => segment.kind !== "text");
        const children: NodeSnapshot[] = structured ? segments.map((segment, segmentIndex) => ({
          id: `${itemId}::list-item:segment:${segmentIndex}`,
          type: `list-item-${segment.kind}`,
          props: segment.kind === "text" ? { inline: segment.inline, text: segment.value }
            : segment.kind === "html" ? { raw: segment.value, html: segment.sanitized ?? segment.value }
            : { raw: segment.value, status: segment.status ?? "pending", error: segment.error },
          children: [],
        })) : [];
        content.forEach((child, childIndex) => {
          if (child === primary) return;
          const snapshot = build(child, `${itemId}::${child.type.name.toLowerCase()}:${childIndex}`, "list");
          if (snapshot) {
            if (snapshot.type === "paragraph") snapshot.props = { ...snapshot.props, tight: !loose };
            children.push(snapshot);
          }
        });
        const itemRange = { from: offset + item.from, to: offset + item.to };
        const itemBlock: Block = { id: itemId, type: "list-item", isFinalized: block.isFinalized,
          payload: { raw: source.slice(item.from, item.to), inline, range: itemRange, meta: { sourceContainer: "list" } } };
        return { id: itemId, type: "list-item", range: itemRange,
          props: { ...props, block: itemBlock, index, inline, text: inlineNodesToPlainText(inline), raw: itemBlock.payload.raw,
            task: task ? true : undefined, checked: task ? task[1].toLowerCase() === "x" : undefined }, children };
      });
      const nested: Block = { id, type: "list", isFinalized: block.isFinalized, payload: { raw: source.slice(node.from, node.to), range, meta: { ...baseMeta, ...props } } };
      return { id, type: "list", props: { block: nested, ...props }, range, children };
    }
    if (name === "Blockquote") {
      const children = childrenOf(node).map((child, index) => build(child, `${id}::${child.type.name.toLowerCase()}:${index}`, "blockquote")).filter((child): child is NodeSnapshot => child !== null);
      const nested: Block = { id, type: "blockquote", isFinalized: block.isFinalized, payload: { raw: source.slice(node.from, node.to), range, meta: baseMeta } };
      return { id, type: "blockquote", props: { block: nested }, range, children };
    }
    let type: Block["type"] = "paragraph";
    let raw = leafText(node);
    let inline: InlineNode[] | undefined;
    if (name === "FencedCode" || name === "CodeBlock" || name === "IndentedCode") {
      type = "code";
      const { code, info } = extractLezerCode(node, source);
      const fence = parseCodeFenceInfo(info);
      baseMeta.code = code;
      baseMeta.info = info;
      baseMeta.lang = fence.lang || "text";
      Object.assign(baseMeta, fence.meta);
      raw = source.slice(node.from, node.to);
    } else if (name.startsWith("ATXHeading") || name.startsWith("SetextHeading")) {
      type = "heading";
      baseMeta.headingLevel = Number(name.slice(name.startsWith("ATX") ? 10 : 13)) || 1;
      inline = parseInline(removeHeadingMarkers(raw));
    } else if (name === "HorizontalRule") {
      type = "hr";
    } else if (name === "HTMLBlock") {
      type = "html";
      baseMeta.lezerNodeType = "HTMLBlock";
    } else {
      inline = parseInline(raw);
    }
    const nested: Block = { id, type, isFinalized: block.isFinalized, payload: { raw, inline, range, meta: baseMeta } };
    const snapshot = createBlockSnapshot(nested);
    if (type === "paragraph") snapshot.props = { ...snapshot.props, inline, text: inlineNodesToPlainText(inline ?? []) };
    return snapshot;
  };
  const root = tree.topNode.firstChild;
  if (!root) return { props: {}, children: [] };
  const snapshot = build(root, block.id, block.type === "list" ? "list" : "blockquote");
  if (!snapshot) return { props: {}, children: [] };
  const { block: _block, ...props } = snapshot.props ?? {};
  return { props, children: snapshot.children ?? [] };
}

/** CodeText ranges already exclude container indentation, unlike the enclosing raw block. */
export function extractLezerCode(node: SyntaxNode, source: string): { code: string; info: string } {
  const columnAt = (position: number): number => {
    const start = source.lastIndexOf("\n", position - 1) + 1;
    let columns = 0;
    for (let index = start; index < position; index++) columns += source[index] === "\t" ? 4 - (columns % 4) : 1;
    return columns;
  };
  let baseIndent = 0;
  const parents: SyntaxNode[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) parents.unshift(parent);
  for (const parent of parents) {
    if (parent.type.name === "ListItem" || parent.type.name === "EmptyListItem") {
      const mark = parent.getChild("ListMark");
      if (mark) {
        let end = mark.to;
        while (source[end] === " " || source[end] === "\t") end++;
        const afterMark = columnAt(mark.to);
        const spacing = columnAt(end) - afterMark;
        baseIndent = afterMark + (spacing >= 1 && spacing <= 4 ? spacing : 1);
      }
    } else if (parent.type.name === "Blockquote") {
      const mark = parent.getChild("QuoteMark");
      if (mark) baseIndent = columnAt(mark.to) + (source[mark.to] === " " || source[mark.to] === "\t" ? 1 : 0);
    }
  }
  const fenced = node.type.name === "FencedCode";
  const fenceIndent = fenced ? Math.max(0, columnAt(node.from) - baseIndent) : 0;
  let code = "";
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.type.name !== "CodeText") continue;
    let text = source.slice(child.from, child.to);
    if (!fenced && source[child.from - 1] === "\t") {
      text = " ".repeat(Math.max(0, columnAt(child.from) - baseIndent - 4)) + text;
    }
    if (fenceIndent > 0) text = text.split("\n").map((line) => line.replace(new RegExp(`^ {0,${fenceIndent}}`), "")).join("\n");
    code += text;
  }
  const infoNode = node.getChild("CodeInfo");
  return { code, info: infoNode ? source.slice(infoNode.from, infoNode.to) : "" };
}
