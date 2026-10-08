import type { MarkdownConfig } from "@lezer/markdown";

/** GFM 0.29 FTP literals, using the same URL node and boundaries as Lezer's GFM autolinks. */
export const FtpAutolink: MarkdownConfig = {
  parseInline: [{
    name: "FtpAutolink",
    before: "Autolink",
    parse(context, next, start) {
      if (next !== 102 || context.slice(start, start + 6) !== "ftp://") return -1;
      if (start > context.offset && /\w/.test(context.slice(start - 1, start))) return -1;
      const bodyStart = start + 6;
      const body = context.slice(bodyStart, context.end);
      const match = /^[\w-]+(?:\.[\w-]+)+(?:\/[^\s<]*)?/.exec(body);
      if (!match || /[\w-]+\.[\w-]+(?:$|\/)/.exec(match[0])?.[0].includes("_")) return -1;
      let length = match[0].length;
      let parentheses = 0;
      for (let index = 0; index < length; index++) {
        if (body[index] === "(") parentheses++;
        else if (body[index] === ")") parentheses--;
      }
      for (;;) {
        const last = body[length - 1];
        if (/[?!.,:*_~]/.test(last)) length--;
        else if (last === ")" && parentheses < 0) {
          length--;
          parentheses++;
        } else if (last === ";") {
          const entity = /&(?:#\d+|#x[a-f\d]+|\w+);$/.exec(body.slice(0, length));
          if (!entity) break;
          length = entity.index;
        } else break;
      }
      if (context.hasOpenLink) {
        const brackets = /(?:[^\[\]]|\[[^\]]*\])*/.exec(body.slice(0, length));
        length = brackets?.[0].length ?? 0;
      }
      const end = bodyStart + length;
      return context.addElement(context.elt("URL", start, end));
    },
  }],
};
