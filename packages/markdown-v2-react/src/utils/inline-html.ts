import React from "react";

import type { InlineHtmlDescriptor } from "@stream-mdx/core";
import type { InlineHtmlRendererMap } from "../types";

export interface RenderInlineHtmlOptions {
  key?: React.Key;
  renderers?: InlineHtmlRendererMap;
  className?: string;
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
  const isInlineTag = INLINE_ELEMENTS.has(descriptor.tagName);

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
      const parsedElement = renderSanitizedHtmlTree(descriptor.sanitized, options.key);
      if (parsedElement) {
        return parsedElement;
      }
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

  return defaultRender();
}

function parseInlineHtmlDescriptor(raw: string | undefined, sanitized: string | undefined): InlineHtmlDescriptor | null {
  const normalizedRaw = typeof raw === "string" ? raw.trim() : "";
  const normalizedSanitized = typeof sanitized === "string" && sanitized.length > 0 ? sanitized.trim() : normalizedRaw;
  if (!normalizedSanitized) {
    return null;
  }

  const match = normalizedSanitized.match(/^<([A-Za-z][\w:-]*)(\s[^>]*)?>([\s\S]*)<\/\1>$/);
  if (!match) {
    return null;
  }

  const [, tagNameRaw, attrString = "", sanitizedInner = ""] = match;
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

function mapAttributesToProps(attrs: Record<string, string>): HtmlAttributeProps & { key?: React.Key } {
  const props: HtmlAttributeProps = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") {
      props.className = value;
    } else if (key === "style") {
      props.style = parseStyleAttribute(value);
    } else if (key === "tabindex" || key === "tabIndex") {
      const normalized = normalizeTabIndex(value);
      if (normalized !== undefined) {
        props.tabIndex = normalized;
      }
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
    const [property, rawVal] = pair.split(":");
    if (!property || rawVal === undefined) continue;
    const camelProp = property.trim().replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
    (style as Record<string, string>)[camelProp] = rawVal.trim();
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

function renderSanitizedHtmlTree(html: string, key: React.Key | undefined): React.ReactElement | null {
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

    const baseKey = typeof key === "string" || typeof key === "number" ? String(key) : "inline-html";
    const children = nodes
      .map((node, index) => convertDomNode(node, `${baseKey}-${index}`))
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

function convertDomNode(node: Node, key: string): React.ReactNode | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }
  const element = node as Element;
  const tagName = element.tagName.toLowerCase();
  const attrs = getElementAttributes(element);
  const props = mapAttributesToProps(attrs);
  props.key = key;
  const children: React.ReactNode[] = [];
  element.childNodes.forEach((child, index) => {
    const converted = convertDomNode(child, `${key}-${index}`);
    if (converted !== null && converted !== undefined) {
      children.push(converted);
    }
  });

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
