import type { MarkdownConfig } from "@lezer/markdown";

// Lezer's native Type 1 recognizes script/pre/style. CommonMark 0.31 also includes textarea.
export const HtmlContinuationExtension: MarkdownConfig = {
  parseBlock: [{
    name: "TextareaBlock",
    before: "HTMLBlock",
    endLeaf: (_context, line) => /^<textarea(?:\s|>|$)/i.test(line.text.slice(line.pos)),
    parse(context, line) {
      if (!/^<textarea(?:\s|>|$)/i.test(line.text.slice(line.pos))) return false;
      const from = context.lineStart + line.pos;
      const depth = context.depth;
      let closed = /<\/textarea>/i.test(line.text);
      while (!closed && context.nextLine()) {
        if (line.depth < depth) break;
        closed = /<\/textarea>/i.test(line.text);
      }
      if (closed) context.nextLine();
      context.addElement(context.elt("HTMLBlock", from, context.prevLineEnd()));
      return true;
    },
  }],
};
