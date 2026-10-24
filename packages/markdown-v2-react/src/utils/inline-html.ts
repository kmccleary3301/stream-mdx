import React from "react";

import { defaultUrlTransform, isForbiddenAttribute, isSafeStyleDeclaration, type HtmlTreeNode, type InlineHtmlDescriptor, type InlineNode, type UrlTransform } from "@stream-mdx/core";
import type { HtmlElements, InlineHtmlRendererMap } from "../types";

import type { ContentComponentsMap } from "../components/content-components";
export interface RenderInlineHtmlOptions {
  key?: React.Key;
  renderers?: InlineHtmlRendererMap;
  className?: string;
  htmlElements?: HtmlElements;
  literalTagContent?: string[];
  parseMarkdown?: (text: string) => React.ReactNode;
  urlTransform?: UrlTransform;
}

/** Render only the sanitized attributes supplied by the engine, with parsed children intact. */
export function renderHtmlInlineNode(
  node: Omit<Extract<InlineNode, { kind: "html" }>, "children">,
  children: React.ReactNode,
  elements?: HtmlElements,
  key?: React.Key,
  textValue?: string,
  urlTransform?: UrlTransform,
  filterElement?: (
    element: { tagName: string; properties: Record<string, unknown>; blockType?: string },
    context: { source: "markdown" | "html"; parentTagName?: string },
    renderElement: () => React.ReactNode,
    renderChildren?: () => React.ReactNode,
  ) => React.ReactNode,
  parentTagName?: string,
  renderPresentation?: (
    tagName: string,
    properties: Readonly<Record<string, unknown>>,
    nativeView: React.ReactNode,
    children: React.ReactNode,
    key: React.Key,
  ) => React.ReactNode,
  renderNativeElement?: (
    tagName: string,
    properties: Readonly<Record<string, unknown>>,
    children: React.ReactNode,
    key: React.Key,
  ) => React.ReactNode,
): React.ReactNode {
  if (node.isClose || node.tagName === "script" || node.tagName === "style") return null;
  if (!node.tagName || node.sanitized === "") {
    return React.createElement(React.Fragment, { key }, children);
  }
  const tag = node.tagName.toLowerCase();
  const props = mapAttributesToProps(node.attributes ?? {}, urlTransform);
  props.key = key;

  const renderElement = () => {
    let nativeView: React.ReactNode;
    if (renderNativeElement) {
      nativeView = renderNativeElement(
        tag,
        props,
        node.isSelfClosing ? undefined : children,
        key ?? tag,
      );
    } else if (tag === "textarea") {
      props.defaultValue = textValue ?? "";
      nativeView = React.createElement(elements?.[tag] ?? tag, props);
    } else {
      nativeView = React.createElement(elements?.[tag] ?? tag, props, node.isSelfClosing ? undefined : children);
    }
    return renderPresentation
      ? renderPresentation(tag, props, nativeView, children, key ?? tag)
      : nativeView;
  };

  if (!filterElement) {
    return renderElement();
  }
  return filterElement(
    { tagName: tag, properties: props },
    { source: "html", parentTagName },
    renderElement,
    () => children,
  );
}

export function renderHtmlOwnershipTree(
  nodes: HtmlTreeNode[],
  elements: HtmlElements,
  renderBlock: (block: Extract<HtmlTreeNode, { kind: "block" }>["block"], parentTagName?: string) => React.ReactNode,
  renderInline?: (nodes: InlineNode[], parentTagName?: string) => React.ReactNode,
  renderInlineElement?: (node: InlineNode, children: React.ReactNode, parentTagName: string | undefined, key: React.Key) => React.ReactNode,
  renderParagraph?: (children: React.ReactNode) => React.ReactNode,
  urlTransform?: UrlTransform,
  filterElement?: (
    element: { tagName: string; properties: Record<string, unknown>; blockType?: string },
    context: { source: "markdown" | "html"; parentTagName?: string },
    renderElement: () => React.ReactNode,
    renderChildren?: () => React.ReactNode,
  ) => React.ReactNode,
  parentTagName?: string,
  contentComponents?: ContentComponentsMap,
  renderPresentation?: (
    tagName: string,
    properties: Readonly<Record<string, unknown>>,
    nativeView: React.ReactNode,
    children: React.ReactNode,
    key: React.Key,
  ) => React.ReactNode,
  parentPath = "html",
): React.ReactNode {
  return nodes.map((node, index) => {
    const nodeKey = `${parentPath}:${index}`;
    if (node.kind === "text") return node.inline && renderInline ? renderInline(node.inline, parentTagName) : (node.rawSource ?? node.text);
    if (node.kind === "block") return renderBlock(node.block, parentTagName);
    if (node.kind === "component") {
      const reg = contentComponents?.[node.name];
      if (!reg) {
        return React.createElement(React.Fragment, { key: nodeKey }, node.rawSource ?? `<${node.name} />`);
      }

      const result = reg.render({
        props: node.props,
        key: index,
        hasChildren: node.children.length > 0,
        renderChildren: () => renderHtmlOwnershipTree(
          node.children,
          elements,
          renderBlock,
          renderInline,
          renderInlineElement,
          renderParagraph,
          urlTransform,
          filterElement,
          node.name,
          contentComponents,
          renderPresentation,
          nodeKey,
        ),
        status: node.status,
        diagnostic: node.diagnostic,
      });
      if (result.kind === "invalid") {
        return React.createElement(React.Fragment, { key: nodeKey }, node.rawSource ?? `<${node.name} />`);
      }
      if (result.kind === "suppressed") {
        return null;
      }
      return result.element;
    }
    const tag = node.tagName.toLowerCase();
    const props = mapAttributesToProps(node.attributes, urlTransform);
    props.key = nodeKey;
    const children = renderHtmlOwnershipTree(node.children, elements, renderBlock, renderInline, renderInlineElement, renderParagraph, urlTransform, filterElement, tag, contentComponents, renderPresentation, nodeKey);
    if (node.paragraphRoot && renderParagraph) {
      const paragraph = filterElement
        ? filterElement(
          { tagName: "p", properties: props, blockType: "paragraph" },
          { source: "markdown", parentTagName },
          () => renderParagraph(children),
          () => children,
        )
        : renderParagraph(children);
      return React.createElement(React.Fragment, { key: nodeKey }, paragraph);
    }
    if (node.inlineNode && renderInlineElement) {
      return React.createElement(React.Fragment, { key: nodeKey }, renderInlineElement(node.inlineNode, children, parentTagName, nodeKey));
    }
    const renderElement = () => {
      let nativeView: React.ReactNode;
      if (tag === "textarea") {
        props.defaultValue = node.children.map((child) => child.kind === "text" ? child.text : "").join("");
        nativeView = React.createElement(elements[tag] ?? tag, props);
      } else {
        const content = tag === "pre" && node.children.every((child) => child.kind === "text" && !child.inline)
          ? node.children.map((child) => child.kind === "text" ? child.text : "").join("")
          : children;
        nativeView = React.createElement(elements[tag] ?? tag, props, node.children.length ? content : undefined);
      }
      return renderPresentation
        ? renderPresentation(tag, props, nativeView, children, nodeKey)
        : nativeView;
    };

    if (!filterElement) {
      return renderElement();
    }
    return filterElement(
      { tagName: tag, properties: props },
      { source: "html", parentTagName },
      renderElement,
      () => children,
    );
  });
}
const BACKTICK_CONTENT = /^`([\s\S]+)`$/;

export const DEFAULT_INLINE_HTML_RENDERERS: InlineHtmlRendererMap = {
  kbd: (descriptor, ctx) => {
    const trimmed = descriptor.rawInner.trim();
    const match = BACKTICK_CONTENT.exec(trimmed);
    if (match) {
      const codeText = decodeHtmlEntities(match[1]);
      const props = mapAttributesToProps(descriptor.attributes);
      if (ctx.key !== undefined && ctx.key !== null) {
        props.key = ctx.key;
      }
      return React.createElement("kbd", props, React.createElement("code", { className: "inline-code" }, codeText));
    }

    return ctx.defaultRender();
  },
};

export function renderInlineHtmlSegment(
  raw: string | undefined,
  sanitized: string | undefined,
  options: RenderInlineHtmlOptions = {},
): React.ReactElement | null {
  const descriptor = parseInlineHtmlDescriptor(raw, sanitized);
  if (!descriptor) {
    return null;
  }

  const className = options.className ?? "markdown-inline-html";
  const hasCustomElement = Boolean(options.htmlElements?.[descriptor.tagName]);
  const isInlineTag = INLINE_ELEMENTS.has(descriptor.tagName) || hasCustomElement;

  const defaultRender = () => {
    if (!descriptor.sanitized || descriptor.sanitized.length === 0) {
      if (!descriptor.text) {
        return null;
      }
      if (options.key !== undefined && options.key !== null) {
        return React.createElement(React.Fragment, { key: options.key }, descriptor.text);
      }
      return React.createElement(React.Fragment, {}, descriptor.text);
    }

    if (isInlineTag) {
      const parsedElement = renderSanitizedHtmlTree(
        descriptor.sanitized,
        options.key,
        options.htmlElements,
        options.literalTagContent,
        options.parseMarkdown,
      );
      if (parsedElement) {
        return parsedElement;
      }
    }

    const customElementComp = options.htmlElements?.[descriptor.tagName];
    if (customElementComp) {
      const props = mapAttributesToProps(descriptor.attributes, options.urlTransform);
      if (options.key !== undefined && options.key !== null) {
        props.key = options.key;
      }
      return React.createElement(customElementComp, props, descriptor.text || descriptor.sanitizedInner || undefined);
    }

    const props: React.HTMLAttributes<HTMLSpanElement> & { key?: React.Key } = {
      className,
      dangerouslySetInnerHTML: { __html: descriptor.sanitized },
    };
    if (options.key !== undefined && options.key !== null) {
      props.key = options.key;
    }
    return React.createElement("span", props);
  };

  if (!hasCustomElement) {
    const allRenderers = options.renderers ? { ...DEFAULT_INLINE_HTML_RENDERERS, ...options.renderers } : DEFAULT_INLINE_HTML_RENDERERS;
    const renderer = allRenderers[descriptor.tagName];
    if (renderer) {
      const rendered = renderer(descriptor, { key: options.key, defaultRender });
      if (rendered) {
        if (options.key !== undefined && options.key !== null && React.isValidElement(rendered) && rendered.key === null) {
          return React.cloneElement(rendered, { key: options.key });
        }
        return rendered;
      }
    }
  }

  return defaultRender();
}

function parseInlineHtmlDescriptor(raw: string | undefined, sanitized: string | undefined): InlineHtmlDescriptor | null {
  const normalizedRaw = typeof raw === "string" ? raw.trim() : "";
  const normalizedSanitized = typeof sanitized === "string" && sanitized.length > 0 ? sanitized.trim() : normalizedRaw;
  if (!normalizedSanitized) {
    return null;
  }

  const pairedMatch = normalizedSanitized.match(/^<([A-Za-z][\w:-]*)((?:\s+[^>]*)?)>([\s\S]*)<\/\1>$/);
  let tagNameRaw: string;
  let attrString = "";
  let sanitizedInner = "";

  if (pairedMatch) {
    tagNameRaw = pairedMatch[1];
    attrString = pairedMatch[2] ?? "";
    sanitizedInner = pairedMatch[3] ?? "";
  } else {
    const selfClosingMatch =
      normalizedSanitized.match(/^<([A-Za-z][\w:-]*)((?:\s+[^>]*)?)\s*(?:\/?>|>)$/) ||
      normalizedRaw.match(/^<([A-Za-z][\w:-]*)((?:\s+[^>]*)?)\s*(?:\/?>|>)$/);
    if (!selfClosingMatch) {
      return null;
    }
    tagNameRaw = selfClosingMatch[1];
    attrString = selfClosingMatch[2] ?? "";
    sanitizedInner = "";
  }
  const tagName = tagNameRaw.toLowerCase();
  const attributes = parseAttributes(attrString);

  let rawInner = "";
  if (normalizedRaw) {
    const rawMatch = normalizedRaw.match(/^<([A-Za-z][\w:-]*)(\s[^>]*)?>([\s\S]*)<\/\1>$/);
    rawInner = rawMatch ? (rawMatch[3] ?? "") : normalizedRaw;
  }

  const text = extractPlainText(rawInner || sanitizedInner);

  return {
    tagName,
    attributes,
    raw: normalizedRaw || normalizedSanitized,
    sanitized: normalizedSanitized,
    rawInner,
    sanitizedInner,
    text,
  };
}

function parseAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!input) return attrs;
  const attrPattern = /([A-Za-z_:][\w:.\-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null = attrPattern.exec(input);
  while (match !== null) {
    const name = match[1];
    if (!name) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[name] = value;
    match = attrPattern.exec(input);
  }
  return attrs;
}

type HtmlAttributeProps = React.HTMLAttributes<HTMLElement> & Record<string, unknown>;

const BOOLEAN_HTML_PROPS: Record<string, true> = {
  allowFullScreen: true, async: true, autoFocus: true, autoPlay: true, checked: true,
  controls: true, default: true, defer: true, disabled: true, formNoValidate: true,
  hidden: true, inert: true, loop: true, multiple: true, muted: true, noModule: true,
  noValidate: true, open: true, playsInline: true, readOnly: true, required: true,
  reversed: true, selected: true, itemScope: true,
};

function mapAttributesToProps(
  attrs: Record<string, string>,
  urlTransform?: UrlTransform,
): HtmlAttributeProps & { key?: React.Key } {
  const props: HtmlAttributeProps = {};
  const transform = urlTransform ?? defaultUrlTransform;
  for (const [key, value] of Object.entries(attrs)) {
    const lower = key.toLowerCase();
    if (isForbiddenAttribute(lower)) {
      continue;
    }
    if (key === "class") {
      props.className = value;
    } else if (key === "style") {
      props.style = parseStyleAttribute(value);
    } else if (key === "tabindex" || key === "tabIndex") {
      const normalized = normalizeTabIndex(value);
      if (normalized !== undefined) {
        props.tabIndex = normalized;
      }
    } else if (lower === "href") {
      const safe = transform(value, "href", { source: "html" });
      if (safe != null) {
        props.href = safe;
      }
    } else if (lower === "src") {
      const safe = transform(value, "src", { source: "html" });
      if (safe != null) {
        props.src = safe;
      }
    } else if (lower === "action") {
      const safe = transform(value, "href", { source: "html" });
      if (safe != null) {
        props.action = safe;
      }
    } else if (lower === "formaction") {
      const safe = transform(value, "href", { source: "html" });
      if (safe != null) {
        props.formAction = safe;
      }
    } else if (lower === "xlink:href" || lower === "xlinkhref") {
      const safe = transform(value, "href", { source: "html" });
      if (safe != null) {
        props.xlinkHref = safe;
      }
    } else if (/^(?:data|aria)[A-Z]/.test(key)) {
      props[key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)] = value;
    } else if (BOOLEAN_HTML_PROPS[key]) {
      props[key] = true;
    } else {
      props[key] = value;
    }
  }
  return props;
}

function parseStyleAttribute(value: string): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (!value) return style;
  const pairs = value.split(";");
  for (const pair of pairs) {
    if (!pair.trim()) continue;
    const separator = pair.indexOf(":");
    if (separator <= 0) continue;
    const property = pair.slice(0, separator).trim();
    const rawVal = pair.slice(separator + 1).trim();
    if (!isSafeStyleDeclaration(property, rawVal)) continue;
    const camelProp = property.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
    (style as Record<string, string>)[camelProp] = rawVal;
  }
  return style;
}

function normalizeTabIndex(value: string): number | undefined {
  const numeric = Number(value);
  return Number.isNaN(numeric) ? undefined : numeric;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractPlainText(value: string): string {
  if (!value) return "";
  const withoutTags = value.replace(/<\/?[^>]+>/g, "");
  return decodeHtmlEntities(withoutTags);
}

const DEFAULT_LITERAL_TAGS = new Set(["code", "pre", "script", "style", "textarea"]);

function renderSanitizedHtmlTree(
  html: string,
  key: React.Key | undefined,
  htmlElements?: HtmlElements,
  literalTagContent?: string[],
  parseMarkdown?: (text: string) => React.ReactNode,
): React.ReactElement | null {
  if (typeof DOMParser === "undefined") {
    return null;
  }
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const body = doc.body;
    const nodes = Array.from(body.childNodes);
    if (nodes.length === 0) {
      return null;
    }

    const literalTags = literalTagContent
      ? new Set([...DEFAULT_LITERAL_TAGS, ...literalTagContent.map((t) => t.toLowerCase())])
      : DEFAULT_LITERAL_TAGS;

    const baseKey = typeof key === "string" || typeof key === "number" ? String(key) : "inline-html";
    const children = nodes
      .map((node, index) => convertDomNode(node, `${baseKey}-${index}`, htmlElements, literalTags, false, parseMarkdown))
      .filter((child): child is React.ReactNode => child !== null && child !== undefined);

    if (children.length === 0) {
      return null;
    }

    if (children.length === 1) {
      const [child] = children;
      if (React.isValidElement(child)) {
        if (key !== undefined && key !== null) {
          return React.cloneElement(child, { key });
        }
        return child as React.ReactElement;
      }
      if (typeof child === "string" || typeof child === "number") {
        if (key !== undefined && key !== null) {
          return React.createElement(React.Fragment, { key }, child);
        }
        return React.createElement(React.Fragment, {}, child);
      }
      return React.createElement(React.Fragment, { key }, child);
    }

    return React.createElement(React.Fragment, { key }, ...children);
  } catch {
    return null;
  }
}

function convertDomNode(
  node: Node,
  key: string,
  htmlElements?: HtmlElements,
  literalTags?: Set<string>,
  parentIsLiteral?: boolean,
  parseMarkdown?: (text: string) => React.ReactNode,
): React.ReactNode | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const rawText = node.textContent ?? "";
    if (parentIsLiteral || !parseMarkdown) {
      return rawText;
    }
    return parseMarkdown(rawText);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }
  const element = node as Element;
  const tagName = element.tagName.toLowerCase();
  const attrs = getElementAttributes(element);
  const props = mapAttributesToProps(attrs);
  props.key = key;
  const isLiteral = parentIsLiteral || (literalTags ? literalTags.has(tagName) : false);
  const children: React.ReactNode[] = [];
  element.childNodes.forEach((child, index) => {
    const converted = convertDomNode(child, `${key}-${index}`, htmlElements, literalTags, isLiteral, parseMarkdown);
    if (converted !== null && converted !== undefined) {
      children.push(converted);
    }
  });

  const customComponent = htmlElements?.[tagName];
  if (customComponent) {
    if (children.length === 0) {
      return React.createElement(customComponent, props);
    }
    return React.createElement(customComponent, props, ...children);
  }

  if (children.length === 0) {
    return React.createElement(tagName, props);
  }
  return React.createElement(tagName, props, ...children);
}

function getElementAttributes(element: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(element.attributes)) {
    attrs[attr.name] = attr.value;
  }
  return attrs;
}

const INLINE_ELEMENTS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "br",
  "img",
  "input",
  "picture",
  "del",
  "ins",
  "cite",
  "code",
  "data",
  "dfn",
  "em",
  "i",
  "kbd",
  "mark",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
  // MathML inline elements commonly emitted by KaTeX
  "annotation",
  "semantics",
  "mtext",
  "mn",
  "mo",
  "mi",
  "mspace",
  "mrow",
  "msup",
  "msub",
  "msubsup",
  "munder",
  "mover",
  "munderover",
  "msqrt",
  "mroot",
  "mtable",
  "mtr",
  "mtd",
]);
