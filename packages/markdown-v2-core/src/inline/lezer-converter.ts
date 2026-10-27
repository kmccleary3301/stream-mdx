import type { NodeSet } from "@lezer/common";
import { decodeHTML5Strict } from "entities";
import type { HtmlOptions, InlineNode, LinkDestinationOptions, SoftBreakMode } from "../types";
import { decodeEntity } from "./entities";
import { findUnmatchedBareAnchorOffsets, sanitizeHtmlTreeInWorker } from "../worker-html-sanitizer";
import { normalizeLinkLabel } from "./reference-collector";
import { getActiveReferencePredicate } from "./reference-guard";
import type { InlineExtension, LinkReferenceDefinition, LinkReferenceMap, MarkdownElement } from "./types";

export interface LezerConverterOptions {
  nodeSet: NodeSet;
  references?: LinkReferenceMap;
  extensionsByName?: Record<string, InlineExtension>;
  html?: HtmlOptions;
  softBreaks?: SoftBreakMode;
  linkDestinations?: LinkDestinationOptions;
}
const RAW_TEXT_TAGS: Record<string, true> = {
  script: true,
  style: true,
  textarea: true,
  title: true,
  xmp: true,
  iframe: true,
  noembed: true,
  noframes: true,
  plaintext: true,
};

function isBareAnchorOpening(raw: string): boolean {
  return /^<a\s*\/?\s*>$/i.test(raw);
}

function resolveReference(map: LinkReferenceMap | undefined, rawLabel: string): LinkReferenceDefinition | undefined {
  // Lezer falls back to a reference after a failed inline link (`[foo](not a link)`) without consulting the
  // reference guard, so the lookup itself records the attempt; a later definition must re-resolve this link.
  getActiveReferencePredicate()?.(rawLabel);
  if (!map) return undefined;
  const key = normalizeLinkLabel(rawLabel);
  if (map instanceof Map) {
    return map.get(key);
  }
  return map[key];
}

function encodeURIWithPercentPreserved(url: string): string {
  if (!url.includes("%")) {
    return encodeURI(url);
  }
  return url
    .split(/(%[0-9a-fA-F]{2})/g)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return encodeURI(part);
    })
    .join("");
}

export function cleanUrl(raw: string, options?: LinkDestinationOptions): string {
  let url = raw.trim();
  if (url.startsWith("<") && url.endsWith(">")) {
    url = url.slice(1, -1);
  }
  if (
    options?.windowsDrivePaths === "preserve" &&
    !url.includes("&") &&
    (url.startsWith("\\\\") || /^[a-zA-Z]:([/\\]|$)/.test(url))
  ) {
    return url;
  }
  // 1. Resolve backslash escapes
  url = url.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
  // 2. Decode HTML entities
  url = decodeHTML5Strict(url);
  // 3. Percent-encode URI while preserving valid existing %-encoded octets
  try {
    return encodeURIWithPercentPreserved(url);
  } catch {
    return url;
  }
}

export function cleanTitle(raw: string): string {
  const trimmed = raw.trim();
  let title = trimmed;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("(") && trimmed.endsWith(")"))
  ) {
    title = trimmed.slice(1, -1);
  }
  // Strip leading and trailing whitespace from each line per CommonMark spec
  if (title.includes("\n")) {
    title = title
      .split("\n")
      .map((line) => line.trim())
      .join("\n");
  }
  // 1. Resolve backslash escapes
  title = title.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
  // 2. Decode HTML entities
  title = decodeHTML5Strict(title);
  return title;
}

export function extractPlainText(nodes: InlineNode[]): string {
  let result = "";
  for (const n of nodes) {
    if (n.kind === "text" || n.kind === "code") {
      result += n.text;
    } else if (n.kind === "image") {
      result += n.alt ?? "";
    } else if ("children" in n && Array.isArray(n.children)) {
      result += extractPlainText(n.children);
    }
  }
  return result;
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

export function mergeAdjacentTextNodes(nodes: InlineNode[], rawSource?: string, sourceOffset = 0): InlineNode[] {
  const result: InlineNode[] = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      if (node.text.length === 0) continue;
      const prev = result[result.length - 1];
      if (prev && prev.kind === "text") {
        const prevRange = prev.sourceRange;
        const nodeRange = node.sourceRange;
        const rangesJoin = Boolean(prevRange && nodeRange && prevRange.to === nodeRange.from);
        const plainSource =
          rawSource !== undefined &&
          rangesJoin &&
          rawSource.slice(prevRange!.from - sourceOffset, prevRange!.to - sourceOffset) === prev.text &&
          rawSource.slice(nodeRange!.from - sourceOffset, nodeRange!.to - sourceOffset) === node.text;
        if (rawSource === undefined ? (!prevRange && !nodeRange) || rangesJoin : plainSource) {
          prev.text += node.text;
          if (rangesJoin) {
            prev.sourceRange = { from: prevRange!.from, to: nodeRange!.to };
          }
          continue;
        }
      }
      result.push({ ...node });
    } else if ("children" in node && Array.isArray(node.children)) {
      result.push({
        ...node,
        children: mergeAdjacentTextNodes(node.children, rawSource, sourceOffset),
      });
    } else {
      result.push({ ...node });
    }
  }
  return result;
}

const VOID_TAGS: Record<string, true> = {
  br: true,
  hr: true,
  img: true,
  meta: true,
  input: true,
  link: true,
  source: true,
  track: true,
  area: true,
  base: true,
  col: true,
  embed: true,
  param: true,
  wbr: true,
};

interface HtmlTagShape {
  tagName?: string;
  declaration: boolean;
  invalid: boolean;
  isClose: boolean;
  isSelfClosing: boolean;
}

function parseHtmlTagShape(raw: string): HtmlTagShape {
  if (raw.startsWith("<!") || raw.startsWith("<?")) {
    return { declaration: true, invalid: false, isClose: false, isSelfClosing: true };
  }
  const tagName = /^<\/?([^\s/>]+)/.exec(raw)?.[1]?.toLowerCase();
  const isClose = raw.startsWith("</");
  const invalid = !tagName || /^<\/\s/.test(raw) || /\/\s+>$/.test(raw);
  return {
    tagName,
    declaration: false,
    invalid,
    isClose,
    isSelfClosing: !isClose && (raw.endsWith("/>") || Boolean(tagName && VOID_TAGS[tagName])),
  };
}

export class LezerInlineConverter {
  private nodeSet: NodeSet;
  private references?: LinkReferenceMap;
  private extensionsByName: Record<string, InlineExtension>;
  private html?: HtmlOptions;
  private softBreaks: SoftBreakMode;
  private linkDestinations?: LinkDestinationOptions;
  private unmatchedAnchorScan?: { source: string; offsets: ReadonlySet<number> };

  constructor(options: LezerConverterOptions) {
    this.nodeSet = options.nodeSet;
    this.references = options.references;
    this.extensionsByName = options.extensionsByName ?? {};
    this.html = options.html;
    this.softBreaks = options.softBreaks ?? "preserve";
    this.linkDestinations = options.linkDestinations;
  }

  setReferences(references: LinkReferenceMap | undefined): void {
    this.references = references;
  }

  private getUnmatchedAnchorOffsets(source: string): ReadonlySet<number> | undefined {
    if (this.html?.unmatchedAnchors !== "literal-bare") return undefined;
    if (!this.unmatchedAnchorScan || this.unmatchedAnchorScan.source !== source) {
      this.unmatchedAnchorScan = { source, offsets: new Set(findUnmatchedBareAnchorOffsets(source)) };
    }
    return this.unmatchedAnchorScan.offsets;
  }

  convert(
    elements: readonly MarkdownElement[],
    text: string,
    from = 0,
    to: number = text.length,
    sourceOffset?: number,
    allowSoftBreaks = true,
  ): InlineNode[] {
    const rawNodes = this.convertRange(elements, text, from, to, sourceOffset, allowSoftBreaks);
    return mergeAdjacentTextNodes(rawNodes, sourceOffset === undefined ? undefined : text, sourceOffset);
  }

  private findMatchingHtmlClose(
    elements: readonly MarkdownElement[],
    index: number,
    text: string,
    to: number,
    tagName: string,
  ): number {
    let depth = 1;
    let rawTextTag: string | undefined;
    for (let next = index + 1; next < elements.length; next++) {
      const candidate = elements[next];
      if (candidate.from >= to) break;
      if (this.nodeSet.types[candidate.type]?.name !== "HTMLTag") continue;
      const shape = parseHtmlTagShape(text.slice(candidate.from, candidate.to));
      if (shape.declaration || shape.invalid || !shape.tagName) continue;
      const candidateName = shape.tagName.toLowerCase();
      if (rawTextTag) {
        if (shape.isClose && candidateName === rawTextTag) rawTextTag = undefined;
        continue;
      }
      if (!shape.isClose && RAW_TEXT_TAGS[candidateName] && !shape.isSelfClosing) {
        rawTextTag = candidateName;
        continue;
      }
      if (candidateName !== tagName.toLowerCase()) continue;
      if (shape.isClose) depth--;
      else if (!shape.isSelfClosing) depth++;
      if (depth === 0) return next;
    }
    return elements.length;
  }

  findUnsettledHtmlScopeStart(
    elements: readonly MarkdownElement[],
    text: string,
    to: number,
  ): number {
    const unmatchedBareAnchorOffsets = this.getUnmatchedAnchorOffsets(text);
    let safeTo = to;
    const inspect = (siblings: readonly MarkdownElement[], from: number, end: number): void => {
      for (let index = from; index < end; index++) {
        const element = siblings[index];
        if (element.from >= safeTo) break;
        if (this.nodeSet.types[element.type]?.name === "HTMLTag") {
          const shape = parseHtmlTagShape(text.slice(element.from, element.to));
          if (!shape.declaration && !shape.invalid && shape.tagName && !shape.isClose && !shape.isSelfClosing) {
            const closeIndex = this.findMatchingHtmlClose(siblings, index, text, safeTo, shape.tagName);
            const close = siblings[closeIndex];
            const bareAnchor = isBareAnchorOpening(text.slice(element.from, element.to));
            const unmatchedBareAnchor = unmatchedBareAnchorOffsets?.has(element.from) ?? false;
            if (bareAnchor && (unmatchedBareAnchor || !close || close.to > safeTo)) continue;
            if (!close || close.to > safeTo) {
              safeTo = Math.min(safeTo, element.from);
            } else {
              inspect(siblings, index + 1, closeIndex);
              if (close.to > safeTo) safeTo = Math.min(safeTo, element.from);
              index = closeIndex;
            }
          } else {
            inspect(element.children, 0, element.children.length);
          }
        } else {
          inspect(element.children, 0, element.children.length);
        }
      }
    };
    inspect(elements, 0, elements.length);
    return safeTo;
  }

  private convertRange(
    elements: readonly MarkdownElement[],
    text: string,
    from: number,
    to: number,
    sourceOffset?: number,
    allowSoftBreaks = true,
  ): InlineNode[] {
    const nodes: InlineNode[] = [];
    const unmatchedBareAnchorOffsets = this.getUnmatchedAnchorOffsets(text);
    let cursor = from;

    for (let index = 0; index < elements.length; index++) {
      const el = elements[index];
      if (el.to <= from || el.from >= to) {
        continue;
      }

      if (el.from > cursor) {
        const gapTo = Math.min(el.from, to);
        this.appendText(nodes, text, cursor, gapTo, sourceOffset, allowSoftBreaks);
      }

      const nodeName = this.nodeSet.types[el.type]?.name ?? "";
      if (this.html?.mode === "literal" && ["HTMLTag", "Comment", "ProcessingInstruction"].includes(nodeName)) {
        let end = el.to;
        let closeIndex = index;
        const shape = nodeName === "HTMLTag" ? parseHtmlTagShape(text.slice(el.from, el.to)) : undefined;
        if (shape?.tagName && !shape.isClose && !shape.isSelfClosing) {
          closeIndex = this.findMatchingHtmlClose(elements, index, text, to, shape.tagName);
          const close = elements[closeIndex];
          if (close) end = close.to;
        }
        const literalNode: InlineNode = { kind: "text", text: text.slice(el.from, end) };
        nodes.push(this.withSourceRange(literalNode, sourceOffset, el.from, end));
        index = closeIndex;
        cursor = end;
        continue;
      }
      if (this.html?.unmatchedAnchors === "literal-bare" && nodeName === "HTMLTag") {
        const raw = text.slice(el.from, el.to);
        const shape = parseHtmlTagShape(raw);
        if (shape.tagName?.toLowerCase() === "a" && !shape.isClose && isBareAnchorOpening(raw)) {
          if (unmatchedBareAnchorOffsets?.has(el.from)) {
            const literalNode: InlineNode = { kind: "text", text: raw };
            nodes.push(this.withSourceRange(literalNode, sourceOffset, el.from, el.to));
            cursor = el.to;
            continue;
          }
        }
      }
      const rawTextTailNodes: InlineNode[] = [];
      const converted = this.convertElement(el, nodeName, text, sourceOffset, allowSoftBreaks);
      let elementEnd = el.to;
      if (converted && !Array.isArray(converted) && converted.kind === "html" &&
          !converted.isClose && !converted.isSelfClosing && converted.tagName) {
        const closeIndex = this.findMatchingHtmlClose(elements, index, text, to, converted.tagName);
        const close = elements[closeIndex];
        const innerTo = close?.from ?? to;
        const end = close?.to ?? to;
        if (!close && RAW_TEXT_TAGS[converted.tagName]) {
          const rawClose = new RegExp(`</${converted.tagName}\\s*>`, "i").exec(text.slice(el.to, to));
          if (rawClose) {
            converted.closingRaw = rawClose[0];
            const tailStart = el.to + rawClose.index + rawClose[0].length;
            for (const node of sanitizeHtmlTreeInWorker(text.slice(tailStart, to), this.html)) {
              if (node.kind === "text") {
                rawTextTailNodes.push(this.withSourceRange({ kind: "text", text: node.text }, sourceOffset, tailStart, to));
              }
            }
          }
        }
        const inner = text.slice(el.to, innerTo);
        converted.raw = text.slice(el.from, end);
        if (close) converted.closingRaw = text.slice(close.from, close.to);
        const literal = ["code", "pre", "textarea", ...(this.html?.literalTagContent ?? [])]
          .some((tag) => tag.toLowerCase() === converted.tagName);
        converted.children = converted.tagName === "script" || converted.tagName === "style"
          ? []
          : literal
            ? [{ kind: "text", text: decodeEntity(inner) }]
            : this.convertRange(elements.slice(index + 1, closeIndex), text, el.to, innerTo, sourceOffset, false);
        index = close ? closeIndex : elements.length;
        cursor = end;
        elementEnd = end;
      }
      if (Array.isArray(converted)) {
        nodes.push(...converted.map((node) => this.withSourceRange(node, sourceOffset, el.from, elementEnd)));
      } else if (converted !== null && converted !== undefined) {
        nodes.push(this.withSourceRange(converted, sourceOffset, el.from, elementEnd));
      }
      nodes.push(...rawTextTailNodes);

      cursor = Math.max(cursor, elementEnd);
    }

    if (cursor < to) {
      this.appendText(nodes, text, cursor, to, sourceOffset, allowSoftBreaks);
    }

    return nodes;
  }

  private withSourceRange(node: InlineNode, sourceOffset: number | undefined, from: number, to: number): InlineNode {
    if (sourceOffset === undefined || node.sourceRange) return node;
    return { ...node, sourceRange: { from: sourceOffset + from, to: sourceOffset + to } };
  }
  private appendText(
    nodes: InlineNode[],
    text: string,
    from: number,
    to: number,
    sourceOffset: number | undefined,
    allowSoftBreaks: boolean,
  ): void {
    const isHardMode = allowSoftBreaks && this.softBreaks === "hard";
    if (!isHardMode) {
      const value = text.slice(from, to);
      if (value) {
        nodes.push({
          kind: "text",
          text: value,
          ...(sourceOffset === undefined ? {} : { sourceRange: { from: sourceOffset + from, to: sourceOffset + to } }),
        });
      }
      return;
    }

    let segmentFrom = from;
    for (let index = from; index < to;) {
      const code = text.charCodeAt(index);
      if (code !== 10 && code !== 13) {
        index++;
        continue;
      }
      if (segmentFrom < index) {
        nodes.push({
          kind: "text",
          text: text.slice(segmentFrom, index),
          ...(sourceOffset === undefined ? {} : { sourceRange: { from: sourceOffset + segmentFrom, to: sourceOffset + index } }),
        });
      }
      const breakTo = code === 13 && text.charCodeAt(index + 1) === 10 ? index + 2 : index + 1;
      nodes.push({
        kind: "br",
        ...(sourceOffset === undefined ? {} : { sourceRange: { from: sourceOffset + index, to: sourceOffset + breakTo } }),
      });
      segmentFrom = breakTo;
      index = breakTo;
    }
    if (segmentFrom < to) {
      nodes.push({
        kind: "text",
        text: text.slice(segmentFrom, to),
        ...(sourceOffset === undefined ? {} : { sourceRange: { from: sourceOffset + segmentFrom, to: sourceOffset + to } }),
      });
    }
  }

  private convertChildrenExcludingMarks(
    children: readonly MarkdownElement[],
    text: string,
    from: number,
    to: number,
    markTypeName: string,
    sourceOffset?: number,
    allowSoftBreaks = true,
  ): InlineNode[] {
    const filtered = children.filter((c) => this.nodeSet.types[c.type]?.name !== markTypeName);
    let contentFrom = from;
    let contentTo = to;
    for (const child of children) {
      if (this.nodeSet.types[child.type]?.name !== markTypeName) continue;
      if (child.from === from) contentFrom = child.to;
      if (child.to === to) contentTo = child.from;
    }
    return this.convertRange(filtered, text, contentFrom, contentTo, sourceOffset, allowSoftBreaks);
  }


  private convertElement(
    el: MarkdownElement,
    nodeName: string,
    text: string,
    sourceOffset?: number,
    allowSoftBreaks = true,
  ): InlineNode | InlineNode[] | null {
    switch (nodeName) {
      case "Emphasis": {
        const children = this.convertChildrenExcludingMarks(el.children, text, el.from, el.to, "EmphasisMark", sourceOffset, allowSoftBreaks);
        return { kind: "em", children };
      }

      case "StrongEmphasis": {
        const children = this.convertChildrenExcludingMarks(el.children, text, el.from, el.to, "EmphasisMark", sourceOffset, allowSoftBreaks);
        return { kind: "strong", children };
      }

      case "Strikethrough": {
        const children = this.convertChildrenExcludingMarks(el.children, text, el.from, el.to, "StrikethroughMark", sourceOffset, allowSoftBreaks);
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
      case "RejectedInlineMath":
        return { kind: "text", text: text.slice(el.from, el.to) };

      case "Escape":
        return { kind: "text", text: text.slice(el.from + 1, el.to) };

      case "Entity":
        return { kind: "text", text: decodeEntity(text.slice(el.from, el.to)) };
      case "Comment":
      case "ProcessingInstruction":
        return { kind: "html", raw: text.slice(el.from, el.to), sanitized: "", isSelfClosing: true };

      case "HTMLTag": {
        // Lezer has already validated this exact range, including quoted '>' and newlines.
        const raw = text.slice(el.from, el.to);
        const shape = parseHtmlTagShape(raw);
        if (shape.declaration) {
          const safe = sanitizeHtmlTreeInWorker(raw, this.html);
          return safe.flatMap((node): InlineNode[] => node.kind === "text" ? [{ kind: "text", text: node.text }] : []);
        }
        if (shape.invalid || !shape.tagName) {
          return { kind: "text", text: raw };
        }
        if (shape.isClose) {
          return { kind: "html", raw, tagName: shape.tagName, isClose: true, sanitized: "" };
        }
        const safe = sanitizeHtmlTreeInWorker(raw, this.html).find((node) => node.kind === "element");
        return {
          kind: "html",
          raw,
          openingRaw: raw,
          tagName: shape.tagName,
          isSelfClosing: shape.isSelfClosing,
          attributes: safe?.kind === "element" ? safe.attributes : undefined,
          sanitized: safe ? undefined : "",
          children: [],
        };
      }
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
          autolink: true,
        };
      }

      case "URL": {
        const url = text.slice(el.from, el.to);
        const isEmail = url.includes("@") && !url.includes(":");
        const href = url.startsWith("www.")
          ? `http://${url}`
          : isEmail && !url.startsWith("mailto:")
            ? `mailto:${url}`
            : url;
        return {
          kind: "link",
          href,
          children: [{ kind: "text", text: url }],
          autolink: true,
        };
      }

      case "Link":
        return this.convertLink(el, text, sourceOffset);

      case "Image":
        return this.convertImage(el, text, sourceOffset);

      default: {
        const ext = this.extensionsByName[nodeName];
        if (ext) {
          const res = ext.toInline(el, text, (children, from, to) =>
            this.convert(children ?? el.children, text, from ?? el.from, to ?? el.to, sourceOffset, allowSoftBreaks),
          );
          return res ?? null;
        }
        return { kind: "text", text: text.slice(el.from, el.to) };
      }
    }
  }

  private convertLink(el: MarkdownElement, text: string, sourceOffset?: number): InlineNode | InlineNode[] {
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

    const children = this.convertRange(textChildren, text, textFrom, textTo, sourceOffset);

    // Inline link: [text](url "title") or [text]()
    const hasParen = el.children.some(
      (c) => this.nodeSet.types[c.type]?.name === "LinkMark" && text.slice(c.from, c.to) === "(",
    );
    if (urlEl || hasParen) {
      const href = urlEl ? cleanUrl(text.slice(urlEl.from, urlEl.to), this.linkDestinations) : "";
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
      return this.convertRange(el.children, text, el.from, el.to, sourceOffset);
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

  private convertImage(el: MarkdownElement, text: string, sourceOffset?: number): InlineNode | InlineNode[] {
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
      } else if (!closeMark) {
        textChildren.push(child);
      }
    }

    const altFrom = openMark ? openMark.to : el.from + 2;
    const altTo = closeMark ? closeMark.from : el.to;
    const rawAltText = text.slice(altFrom, altTo);
    const innerChildren = this.convertRange(textChildren, text, altFrom, altTo, sourceOffset);
    const alt = extractPlainText(innerChildren);

    const hasParen = el.children.some(
      (c) => this.nodeSet.types[c.type]?.name === "LinkMark" && text.slice(c.from, c.to) === "(",
    );
    if (urlEl || hasParen) {
      const src = urlEl ? cleanUrl(text.slice(urlEl.from, urlEl.to), this.linkDestinations) : "";
      const title = titleEl ? cleanTitle(text.slice(titleEl.from, titleEl.to)) : undefined;
      const imgNode: InlineNode = { kind: "image", src, alt };
      if (title !== undefined) imgNode.title = title;
      return imgNode;
    }

    if (labelEl) {
      const labelSlice = text.slice(labelEl.from, labelEl.to);
      const innerLabel = labelSlice.startsWith("[") && labelSlice.endsWith("]") ? labelSlice.slice(1, -1) : labelSlice;
      const refKey = innerLabel.length > 0 ? innerLabel : rawAltText;
      const resolved = resolveReference(this.references, refKey);
      if (resolved) {
        const imgNode: InlineNode = { kind: "image", src: resolved.href, alt };
        if (resolved.title !== undefined) imgNode.title = resolved.title;
        return imgNode;
      }
      return [{ kind: "text", text: text.slice(el.from, el.to) }];
    }

    // Shortcut image: ![alt]
    const resolved = resolveReference(this.references, rawAltText);
    if (resolved) {
      const imgNode: InlineNode = { kind: "image", src: resolved.href, alt };
      if (resolved.title !== undefined) imgNode.title = resolved.title;
      return imgNode;
    }

    return [{ kind: "text", text: text.slice(el.from, el.to) }];
  }
}
