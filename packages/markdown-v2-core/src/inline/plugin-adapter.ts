import type { RegexInlinePlugin } from "../types";
import type { InlineExtension } from "./types";

function ensureSticky(re: RegExp): RegExp {
  if (re.sticky) return re;
  const flags = re.flags.includes("y") ? re.flags : `${re.flags.replace("g", "")}y`;
  return new RegExp(re.source, flags);
}

/**
 * Compiles a RegexInlinePlugin into a Lezer InlineExtension.
 */
export function compileRegexPluginToExtension(plugin: RegexInlinePlugin): InlineExtension {
  const nodeName = `Custom_${plugin.id.replace(/[^A-Za-z0-9_]/g, "_")}`;
  const stickyRe = ensureSticky(plugin.re);
  const fastCheck = plugin.fastCheck;

  let before: string | undefined;
  let after: string | undefined;

  if (plugin.priority < 2) {
    before = "Escape";
  } else if (plugin.priority < 3) {
    before = "InlineCode";
  } else if (plugin.priority < 4) {
    before = "Link";
  } else if (plugin.priority < 6) {
    before = "Emphasis";
  } else if (plugin.priority < 10) {
    after = "Emphasis";
  } else {
    after = "Link";
  }

  return {
    name: plugin.id,
    lezer: {
      defineNodes: [nodeName],
      parseInline: [
        {
          name: nodeName,
          before,
          after,
          parse(cx, _next, pos) {
            if (fastCheck && !fastCheck(cx.text)) {
              return -1;
            }
            stickyRe.lastIndex = pos;
            const match = stickyRe.exec(cx.text);
            if (!match || match.index !== pos || match[0].length === 0) {
              return -1;
            }
            const end = pos + match[0].length;
            return cx.addElement(cx.elt(nodeName, pos, end));
          },
        },
      ],
    },
    toInline(element, text) {
      stickyRe.lastIndex = element.from;
      const match = stickyRe.exec(text);
      if (match && match.index === element.from) {
        return plugin.toNode(match);
      }
      return null;
    },
  };
}

export function createDefaultRegexPlugins(): RegexInlinePlugin[] {
  return [
    {
      id: "citations",
      priority: 10,
      re: /\[\^([^\]\n]+)\]|@cite\{([^}\n]+)\}|\{cite:([^}\n]+)\}/g,
      toNode: (match) => ({ kind: "citation", id: match[1] || match[2] || match[3] }),
      fastCheck: (text) => text.indexOf("@cite") !== -1 || text.indexOf("[^") !== -1 || text.indexOf("{cite:") !== -1,
      anticipation: {
        start: /@cite\{|\{cite:/g,
        end: /\}/g,
        full: /@cite\{[^}\n]+?\}|\{cite:[^}\n]+?\}/g,
        append: "}",
        maxScanChars: 120,
      },
    },
    {
      id: "mentions",
      priority: 15,
      re: /@([a-zA-Z0-9_]+)/g,
      toNode: (match) => ({ kind: "mention", handle: match[1] }),
      fastCheck: (text) => text.indexOf("@") !== -1,
    },
  ];
}
