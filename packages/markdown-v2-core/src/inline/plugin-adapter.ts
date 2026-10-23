import type { InlineContext } from "@lezer/markdown";
import type { InlineNode, RegexInlinePlugin, SyntaxRuleSpec } from "../types";
import type { InlineExtension } from "./types";
import { reportIncompleteNativeCandidate } from "./native-inline-state";

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
  // A context's text is immutable; do not rescan it at every token position.
  const fastCheckResults = fastCheck ? new WeakMap<InlineContext, boolean>() : undefined;

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
            if (fastCheck && fastCheckResults) {
              let eligible = fastCheckResults.get(cx);
              if (eligible === undefined) {
                eligible = fastCheck(cx.text);
                fastCheckResults.set(cx, eligible);
              }
              if (!eligible) return -1;
            }
            stickyRe.lastIndex = pos;
            const match = stickyRe.exec(cx.text);
            if (!match || match.index !== pos || match[0].length === 0) {
              if (plugin.id === "citations") {
                if (_next === 64) reportIncompleteNativeCandidate(cx, pos, "@cite{", "}", true);
                else if (_next === 123) reportIncompleteNativeCandidate(cx, pos, "{cite:", "}", true);
                else if (_next === 91) reportIncompleteNativeCandidate(cx, pos, "[^", "]", true);
              }
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

/**
 * Compiles a declarative SyntaxRuleSpec into a Lezer InlineExtension.
 */
export function compileSyntaxRuleToExtension(rule: SyntaxRuleSpec): InlineExtension {
  const nodeName = `Custom_Rule_${rule.name.replace(/[^A-Za-z0-9_]/g, "_")}`;
  const rawFlags = rule.pattern.flags || "";
  const cleanedFlags = rawFlags.replace(/[gy]/g, "");
  let stickyRe: RegExp;
  try {
    stickyRe = new RegExp(rule.pattern.source, `${cleanedFlags}yd`);
  } catch {
    stickyRe = new RegExp(rule.pattern.source, `${cleanedFlags}y`);
  }

  const trigger = rule.trigger;
  const before = rule.before;

  return {
    name: rule.name,
    lezer: {
      defineNodes: [nodeName],
      parseInline: [
        {
          name: nodeName,
          before: rule.before ?? "Link",
          parse(cx, _next, pos) {
            const localPos = pos - cx.offset;
            if (localPos < 0 || localPos >= cx.text.length) {
              return -1;
            }
            if (trigger && !cx.text.startsWith(trigger, localPos)) {
              return -1;
            }
            stickyRe.lastIndex = localPos;
            const match = stickyRe.exec(cx.text);
            if (!match || match.index !== localPos || match[0].length === 0) {
              if (rule.anticipation) {
                reportIncompleteNativeCandidate(cx, pos, rule.anticipation.open, rule.anticipation.close);
              }
              return -1;
            }
            const end = pos + match[0].length;
            if (rule.content !== undefined && match[rule.content] !== undefined) {
              const contentText = match[rule.content];
              let localCStart: number;
              const indices = (match as RegExpExecArray & { indices?: Array<[number, number] | undefined> }).indices;
              const range = indices?.[rule.content];
              if (range) {
                localCStart = range[0];
              } else {
                const offset = match[0].indexOf(contentText);
                localCStart = localPos + (offset >= 0 ? offset : 0);
              }
              const docCStart = cx.offset + localCStart;
              const innerElts = cx.parser.parseInline(contentText, docCStart);
              return cx.addElement(cx.elt(nodeName, pos, end, innerElts));
            }
            return cx.addElement(cx.elt(nodeName, pos, end));
          },
        },
      ],
    },
    toInline(element, text, convertChildren) {
      stickyRe.lastIndex = element.from;
      const match = stickyRe.exec(text);
      if (!match || match.index !== element.from) {
        return null;
      }
      const attrs: Record<string, string> = {};
      if (rule.attrs) {
        for (const [key, val] of Object.entries(rule.attrs)) {
          if (typeof val === "number") {
            attrs[key] = match[val] ?? "";
          } else {
            attrs[key] = String(val);
          }
        }
      }
      let children: InlineNode[] | undefined;
      if (rule.content !== undefined && typeof convertChildren === "function") {
        const contentText = match[rule.content];
        if (contentText !== undefined) {
          const indices = (match as RegExpExecArray & { indices?: Array<[number, number] | undefined> }).indices;
          const range = indices?.[rule.content];
          const contentFrom = range ? element.from + (range[0] - match.index) : element.from + Math.max(0, match[0].indexOf(contentText));
          const contentTo = contentFrom + contentText.length;
          children = convertChildren(element.children, contentFrom, contentTo);
        } else {
          children = convertChildren(element.children);
        }
      }
      return {
        kind: "plugin",
        name: rule.name,
        attrs,
        children,
        raw: match[0],
      };
    },
  };
}
