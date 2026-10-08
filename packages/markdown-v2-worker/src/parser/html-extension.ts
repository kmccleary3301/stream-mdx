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
      // Consume raw lines until the closing tag, mirroring the built-in Type 1 HTML block.
      // Its guard against leaving the enclosing block uses the internal `Line.depth`; the public
      // counterpart is `Line.basePos`, the position after the enclosing composite markers, which
      // shrinks below the captured value once the new line is no longer inside this context.
      const basePos = line.basePos;
      let closed = /<\/textarea>/i.test(line.text);
      while (!closed && context.nextLine() && line.basePos >= basePos) {
        closed = /<\/textarea>/i.test(line.text);
      }
      if (closed) context.nextLine();
      context.addElement(context.elt("HTMLBlock", from, context.prevLineEnd()));
      return true;
    },
  }],
};
