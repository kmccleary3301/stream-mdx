import type { NodeSet } from "@lezer/common";
import type { InlineNode } from "../types";
import { decodeEntity } from "./entities";
import { normalizeLinkLabel } from "./reference-collector";
import type { InlineExtension, LinkReferenceDefinition, LinkReferenceMap, MarkdownElement } from "./types";

export interface LezerConverterOptions {
  nodeSet: NodeSet;
  references?: LinkReferenceMap;
  extensionsByName?: Record<string, InlineExtension>;
}

function resolveReference(map: LinkReferenceMap | undefined, rawLabel: string): LinkReferenceDefinition | undefined {
  if (!map) return undefined;
  const key = normalizeLinkLabel(rawLabel);
  if (map instanceof Map) {
    return map.get(key);
  }
  return map[key];
}

function cleanUrl(raw: string): string {
  let url = raw.trim();
  if (url.startsWith("<") && url.endsWith(">")) {
    url = url.slice(1, -1);
  }
  // CommonMark: unescape backslash escapes in destination
  return url.replace(/\\([\\`*_{}\[\]()#+\-.!>~])/g, "$1");
}

function cleanTitle(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("(") && trimmed.endsWith(")"))
  ) {
    return trimmed.slice(1, -1).replace(/\\([\\`*_{}\[\]()#+\-.!>~"'])/g, "$1");
  }
  return trimmed;
}

function normalizeInlineCodeText(raw: string): string {
  // CommonMark 5.1: newlines converted to spaces
  const singleLine = raw.replace(/\r?\n/g, " ");
  // If begins and ends with space and not all spaces, strip one leading and one trailing
  if (singleLine.startsWith(" ") && singleLine.endsWith(" ") && singleLine.trim().length > 0) {
    return singleLine.slice(1, -1);
  }
  return singleLine;
}

export function mergeAdjacentTextNodes(nodes: InlineNode[]): InlineNode[] {
  const result: InlineNode[] = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      if (node.text.length === 0) continue;
      const prev = result[result.length - 1];
      if (prev && prev.kind === "text") {
        prev.text += node.text;
      } else {
        result.push({ kind: "text", text: node.text });
      }
    } else if ("children" in node && Array.isArray(node.children)) {
      result.push({
        ...node,
        children: mergeAdjacentTextNodes(node.children),
      });
    } else {
      result.push(node);
    }
  }
  return result;
}

export class LezerInlineConverter {
  private nodeSet: NodeSet;
  private references?: LinkReferenceMap;
  private extensionsByName: Record<string, InlineExtension>;

  constructor(options: LezerConverterOptions) {
    this.nodeSet = options.nodeSet;
    this.references = options.references;
    this.extensionsByName = options.extensionsByName ?? {};
  }

  setReferences(references: LinkReferenceMap | undefined): void {
    this.references = references;
  }

  convert(elements: readonly MarkdownElement[], text: string, from = 0, to: number = text.length): InlineNode[] {
    const rawNodes = this.convertRange(elements, text, from, to);
    return mergeAdjacentTextNodes(rawNodes);
  }

  private convertRange(elements: readonly MarkdownElement[], text: string, from: number, to: number): InlineNode[] {
    const nodes: InlineNode[] = [];
    let cursor = from;

    for (const el of elements) {
      if (el.to <= from || el.from >= to) {
        continue;
      }

      // Add text gap before element
      if (el.from > cursor) {
        const gap = text.slice(cursor, Math.min(el.from, to));
        if (gap) {
          nodes.push({ kind: "text", text: gap });
        }
      }

      const nodeName = this.nodeSet.types[el.type]?.name ?? "";
      const converted = this.convertElement(el, nodeName, text);
      if (Array.isArray(converted)) {
        nodes.push(...converted);
      } else if (converted !== null && converted !== undefined) {
        nodes.push(converted);
      }

      cursor = Math.max(cursor, el.to);
    }

    // Add trailing text gap
    if (cursor < to) {
      const remaining = text.slice(cursor, to);
      if (remaining) {
        nodes.push({ kind: "text", text: remaining });
      }
    }

    return nodes;
  }

  private convertChildrenExcludingMarks(
    children: readonly MarkdownElement[],
    text: string,
    from: number,
    to: number,
    markTypeName: string,
  ): InlineNode[] {
    // Filter out delimiter marks
    const filtered = children.filter((c) => {
      const name = this.nodeSet.types[c.type]?.name;
      return name !== markTypeName;
    });

    // Content bounds are inside the marks
    let contentFrom = from;
    let contentTo = to;
    for (const c of children) {
      const name = this.nodeSet.types[c.type]?.name;
      if (name === markTypeName) {
        if (c.from === from) {
          contentFrom = c.to;
        }
        if (c.to === to) {
          contentTo = c.from;
        }
      }
    }

    return this.convertRange(filtered, text, contentFrom, contentTo);
  }

  private convertElement(el: MarkdownElement, nodeName: string, text: string): InlineNode | InlineNode[] | null {
    switch (nodeName) {
      case "Emphasis": {
        const children = this.convertChildrenExcludingMarks(el.children, text, el.from, el.to, "EmphasisMark");
        return { kind: "em", children };
      }

      case "StrongEmphasis": {
        const children = this.convertChildrenExcludingMarks(el.children, text, el.from, el.to, "EmphasisMark");
        return { kind: "strong", children };
      }

      case "Strikethrough": {
        const children = this.convertChildrenExcludingMarks(el.children, text, el.from, el.to, "StrikethroughMark");
        return { kind: "strike", children };
      }

      case "InlineCode": {
        let codeStart = el.from;
        let codeEnd = el.to;
        for (const child of el.children) {
          const name = this.nodeSet.types[child.type]?.name;
          if (name === "CodeMark") {
            if (child.from === el.from) {
              codeStart = child.to;
            }
            if (child.to === el.to) {
              codeEnd = child.from;
            }
          }
        }
        const innerText = text.slice(codeStart, codeEnd);
        return { kind: "code", text: normalizeInlineCodeText(innerText) };
      }

      case "HardBreak":
        return { kind: "br" };

      case "Escape":
        return { kind: "text", text: text.slice(el.from + 1, el.to) };

      case "Entity":
        return { kind: "text", text: decodeEntity(text.slice(el.from, el.to)) };

      case "HTMLTag":
        // Preserve HTML tag verbatim as text so downstream mixed-content / react handle it
        return { kind: "text", text: text.slice(el.from, el.to) };

      case "InlineMath": {
        const tex = text.slice(el.from + 1, el.to - 1).trim();
        return { kind: "math-inline", tex };
      }

      case "DisplayMath": {
        const tex = text.slice(el.from + 2, el.to - 2).trim();
        return { kind: "math-display", tex };
      }

      case "Autolink": {
        let urlText = "";
        for (const child of el.children) {
          if (this.nodeSet.types[child.type]?.name === "URL") {
            urlText = text.slice(child.from, child.to);
            break;
          }
        }
        if (!urlText) {
          urlText = text.slice(el.from + 1, el.to - 1);
        }
        const isEmail = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(urlText);
        const href = isEmail && !urlText.startsWith("mailto:") ? `mailto:${urlText}` : urlText;
        return {
          kind: "link",
          href,
          children: [{ kind: "text", text: urlText }],
        };
      }

      case "URL": {
        const url = text.slice(el.from, el.to);
        const isEmail = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(url);
        const href = url.startsWith("www.")
          ? `http://${url}`
          : isEmail && !url.startsWith("mailto:")
            ? `mailto:${url}`
            : url;
        return {
          kind: "link",
          href,
          children: [{ kind: "text", text: url }],
        };
      }

      case "Link":
        return this.convertLink(el, text);

      case "Image":
        return this.convertImage(el, text);

      default: {
        const ext = this.extensionsByName[nodeName];
        if (ext) {
          const res = ext.toInline(el, text, (children, from, to) =>
            this.convert(children ?? el.children, text, from ?? el.from, to ?? el.to),
          );
          return res ?? null;
        }
        return { kind: "text", text: text.slice(el.from, el.to) };
      }
    }
  }

  private convertLink(el: MarkdownElement, text: string): InlineNode | InlineNode[] {
    let openMark: MarkdownElement | null = null;
    let closeMark: MarkdownElement | null = null;
    let urlEl: MarkdownElement | null = null;
    let titleEl: MarkdownElement | null = null;
    let labelEl: MarkdownElement | null = null;
    const textChildren: MarkdownElement[] = [];

    for (const child of el.children) {
      const name = this.nodeSet.types[child.type]?.name;
      if (name === "LinkMark") {
        const markSlice = text.slice(child.from, child.to);
        if (markSlice === "[" && !openMark) {
          openMark = child;
        } else if (markSlice === "]" && !closeMark) {
          closeMark = child;
        }
      } else if (name === "URL") {
        urlEl = child;
      } else if (name === "LinkTitle") {
        titleEl = child;
      } else if (name === "LinkLabel") {
        labelEl = child;
      } else if (!closeMark) {
        textChildren.push(child);
      }
    }

    const textFrom = openMark ? openMark.to : el.from;
    const textTo = closeMark ? closeMark.from : el.to;
    const rawLinkText = text.slice(textFrom, textTo);

    // Footnote reference: [^label]
    if (!urlEl && !labelEl && rawLinkText.startsWith("^")) {
      const footnoteLabel = rawLinkText.slice(1);
      if (/^[A-Za-z0-9_-]+$/.test(footnoteLabel)) {
        return { kind: "footnote-ref", label: footnoteLabel };
      }
    }

    const children = this.convertRange(textChildren, text, textFrom, textTo);

    // Inline link: [text](url "title")
    if (urlEl) {
      const href = cleanUrl(text.slice(urlEl.from, urlEl.to));
      const title = titleEl ? cleanTitle(text.slice(titleEl.from, titleEl.to)) : undefined;
      const linkNode: InlineNode = { kind: "link", href, children };
      if (title !== undefined) linkNode.title = title;
      return linkNode;
    }

    // Reference link: [text][ref] or [text][]
    if (labelEl) {
      const labelSlice = text.slice(labelEl.from, labelEl.to);
      const innerLabel = labelSlice.startsWith("[") && labelSlice.endsWith("]") ? labelSlice.slice(1, -1) : labelSlice;
      const refKey = innerLabel.length > 0 ? innerLabel : rawLinkText;
      const resolved = resolveReference(this.references, refKey);
      if (resolved) {
        const linkNode: InlineNode = { kind: "link", href: resolved.href, children };
        if (resolved.title !== undefined) linkNode.title = resolved.title;
        return linkNode;
      }
      // Undefined reference: CommonMark treats as literal text
      return this.convertRange(el.children, text, el.from, el.to);
    }

    // Shortcut link: [text]
    const resolved = resolveReference(this.references, rawLinkText);
    if (resolved) {
      const linkNode: InlineNode = { kind: "link", href: resolved.href, children };
      if (resolved.title !== undefined) linkNode.title = resolved.title;
      return linkNode;
    }

    // Undefined reference: CommonMark treats as literal text
    return [{ kind: "text", text: `[${rawLinkText}]` }];
  }

  private convertImage(el: MarkdownElement, text: string): InlineNode | InlineNode[] {
    let openMark: MarkdownElement | null = null;
    let closeMark: MarkdownElement | null = null;
    let urlEl: MarkdownElement | null = null;
    let titleEl: MarkdownElement | null = null;
    let labelEl: MarkdownElement | null = null;

    for (const child of el.children) {
      const name = this.nodeSet.types[child.type]?.name;
      if (name === "LinkMark") {
        const markSlice = text.slice(child.from, child.to);
        if (markSlice === "![" && !openMark) {
          openMark = child;
        } else if (markSlice === "]" && !closeMark) {
          closeMark = child;
        }
      } else if (name === "URL") {
        urlEl = child;
      } else if (name === "LinkTitle") {
        titleEl = child;
      } else if (name === "LinkLabel") {
        labelEl = child;
      }
    }

    const altFrom = openMark ? openMark.to : el.from + 2;
    const altTo = closeMark ? closeMark.from : el.to;
    const altText = text.slice(altFrom, altTo);

    if (urlEl) {
      const src = cleanUrl(text.slice(urlEl.from, urlEl.to));
      const title = titleEl ? cleanTitle(text.slice(titleEl.from, titleEl.to)) : undefined;
      const imgNode: InlineNode = { kind: "image", src, alt: altText ?? "" };
      if (title !== undefined) imgNode.title = title;
      return imgNode;
    }

    if (labelEl) {
      const labelSlice = text.slice(labelEl.from, labelEl.to);
      const innerLabel = labelSlice.startsWith("[") && labelSlice.endsWith("]") ? labelSlice.slice(1, -1) : labelSlice;
      const refKey = innerLabel.length > 0 ? innerLabel : altText;
      const resolved = resolveReference(this.references, refKey);
      if (resolved) {
        const imgNode: InlineNode = { kind: "image", src: resolved.href, alt: altText ?? "" };
        if (resolved.title !== undefined) imgNode.title = resolved.title;
        return imgNode;
      }
      return [{ kind: "text", text: text.slice(el.from, el.to) }];
    }

    // Shortcut image: ![alt]
    const resolved = resolveReference(this.references, altText);
    if (resolved) {
      const imgNode: InlineNode = { kind: "image", src: resolved.href, alt: altText ?? "" };
      if (resolved.title !== undefined) imgNode.title = resolved.title;
      return imgNode;
    }

    return [{ kind: "text", text: text.slice(el.from, el.to) }];
  }
}
