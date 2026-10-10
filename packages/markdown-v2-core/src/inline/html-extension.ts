import type { MarkdownConfig } from "@lezer/markdown";

/** CommonMark 0.31 comment endings, before Lezer's older HTML comment grammar. */
export const HtmlCommentCompatibility: MarkdownConfig = {
  parseInline: [{
    name: "HtmlCommentCompatibility",
    before: "HTMLTag",
    parse(context, next, start) {
      if (next !== 60 || context.slice(start, start + 4) !== "<!--") return -1;
      const rest = context.slice(start + 4, context.end);
      let length: number;
      if (rest.startsWith(">")) length = 1;
      else if (rest.startsWith("->")) length = 2;
      else {
        const close = rest.indexOf("-->");
        if (close < 0) return -1;
        length = close + 3;
      }
      return context.addElement(context.elt("Comment", start, start + 4 + length));
    },
  }],
};
