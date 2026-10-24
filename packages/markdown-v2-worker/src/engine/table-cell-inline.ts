import type { InlineNode, InlineParser } from "@stream-mdx/core";

type InlineParseOptions = NonNullable<Parameters<InlineParser["parse"]>[1]>;

/**
 * Parses one GFM table cell. GFM removes the backslash of every `\|` before inline parsing, so code spans and raw
 * HTML hold a bare pipe. Source ranges are mapped back onto the authored cell text, which still has the backslashes.
 */
export function parseTableCellInline(inlineParser: InlineParser, value: string, options: InlineParseOptions = {}): InlineNode[] {
  if (!value.includes("\\|")) return inlineParser.parse(value, options);
  // Positions in the unescaped text of the pipes whose backslash was removed, ascending.
  const unescapedPipes: number[] = [];
  let text = "";
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "\\" && value[index + 1] === "|") {
      unescapedPipes.push(text.length);
      text += "|";
      index++;
    } else {
      text += value[index];
    }
  }
  const nodes = inlineParser.parse(text, options);
  const sourceOffset = options.sourceOffset;
  if (sourceOffset === undefined) return nodes;
  // An unescaped position maps forward by the backslashes removed before it; a range starting at an unescaped pipe
  // therefore starts at its backslash.
  const toSource = (position: number): number => {
    let removed = 0;
    while (removed < unescapedPipes.length && unescapedPipes[removed] < position - sourceOffset) removed++;
    return position + removed;
  };
  const remap = (node: InlineNode): InlineNode => {
    const mapped: InlineNode = node.sourceRange
      ? { ...node, sourceRange: { from: toSource(node.sourceRange.from), to: toSource(node.sourceRange.to) } }
      : { ...node };
    if ("children" in mapped && Array.isArray(mapped.children)) {
      (mapped as { children: InlineNode[] }).children = (mapped.children as InlineNode[]).map(remap);
    }
    return mapped;
  };
  return nodes.map(remap);
}
