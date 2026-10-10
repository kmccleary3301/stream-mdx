import type { Line, MarkdownConfig } from "@lezer/markdown";

/**
 * Lezer's built-in HTML block stops consuming continuation lines once the new line is no longer
 * inside the enclosing composite contexts (`line.depth < cx.stack.length`). `Line.depth` is
 * `@internal` in the published typings, so it is read through this subtype view (a runtime-guarded
 * read of the same field the built-in consumes) instead of being inferred from `Line.basePos`,
 * whose string position legitimately shrinks between `> ` and `>` on consecutive lines of one quote
 * (and between tab- and space-indented list lines).
 */
interface LineWithDepth extends Line {
  readonly depth?: number;
}

const lineDepth = (line: Line): number | undefined => {
  const depth = (line as LineWithDepth).depth;
  return typeof depth === "number" ? depth : undefined;
};

// Lezer's native Type 1 recognizes script/pre/style. CommonMark 0.31 also includes textarea.
export const HtmlContinuationExtension: MarkdownConfig = {
  parseBlock: [{
    name: "TextareaBlock",
    before: "HTMLBlock",
    endLeaf: (_context, line) => /^<textarea(?:\s|>|$)/i.test(line.text.slice(line.pos)),
    parse(context, line) {
      if (!/^<textarea(?:\s|>|$)/i.test(line.text.slice(line.pos))) return false;
      const from = context.lineStart + line.pos;
      // Consume raw lines until the closing tag, mirroring the built-in Type 1 HTML block including
      // its guard against consuming lines that have left the enclosing container context.
      let closed = /<\/textarea>/i.test(line.text);
      while (!closed && context.nextLine()) {
        const depth = lineDepth(line);
        if (depth !== undefined && depth < context.depth) break;
        closed = /<\/textarea>/i.test(line.text);
      }
      if (closed) context.nextLine();
      context.addElement(context.elt("HTMLBlock", from, context.prevLineEnd()));
      return true;
    },
  }],
};
