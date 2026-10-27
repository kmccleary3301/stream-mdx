import * as rehypeParse from "rehype-parse";
import * as rehypeSanitize from "rehype-sanitize";
import * as rehypeStringify from "rehype-stringify";
import { type Plugin, unified } from "unified";
import type { Block, HtmlOptions, HtmlTreeNode, InlineNode } from "./types";
import { createProtocolPolicyUrlTransform } from "./url-policy";

type RehypeSanitizeModule = typeof import("rehype-sanitize");
const rehypeSanitizeModule = rehypeSanitize as RehypeSanitizeModule;
const defaultSchema = rehypeSanitizeModule.defaultSchema;
type Schema = typeof defaultSchema;

const resolvePlugin = (mod: unknown): unknown => {
  if (typeof mod === "function") return mod;
  if (mod && typeof (mod as { default?: unknown }).default === "function") {
    return (mod as { default?: unknown }).default;
  }
  if (mod && typeof (mod as { default?: { default?: unknown } }).default?.default === "function") {
    return (mod as { default?: { default?: unknown } }).default?.default;
  }
  return mod;
};

type ParsePlugin = Plugin<[{ fragment?: boolean }]>;
type SanitizePlugin = Plugin<[Schema?]>;
const rehypeParsePlugin = resolvePlugin(rehypeParse) as ParsePlugin;
const rehypeSanitizePlugin = resolvePlugin(rehypeSanitizeModule) as SanitizePlugin;
const rehypeStringifyPlugin = resolvePlugin(rehypeStringify) as Plugin<[]>;
type AttributeDefinition = string | [string, ...(string | number | boolean | RegExp | null | undefined)[]];

const FORBIDDEN_ATTRS: Record<string, true> = {
  srcdoc: true,
  script: true,
};

export function isForbiddenAttribute(attr: string): boolean {
  const lower = attr.toLowerCase();
  return lower.startsWith("on") || FORBIDDEN_ATTRS[lower] === true;
}

const SANITIZED_SCHEMA: Schema = createSchema();

const sanitizeProcessor = unified()
  .use(rehypeParsePlugin, { fragment: true })
  .use(rehypeSanitizePlugin, SANITIZED_SCHEMA)
  .use(() => (tree) => {
    sanitizeHastStyles(tree);
  })
  .use(rehypeStringifyPlugin)
  .freeze();

/**
 * Code-row sanitation declaration shared by the DOM path (`sanitizeCodeHTML`
 * in ./security, DOMPurify) and the DOM-free path below. This is the single
 * source of truth so Node/SSR and browser sanitize code rows identically:
 * only `pre`/`code`/`span`/`div`/`br` with `class`, `data-*`, and `style`.
 */
export const CODE_ROW_ALLOWED_TAGS = ["pre", "code", "span", "div", "br"] as const;
export const CODE_ROW_ALLOWED_ATTRS = ["class", "data-*", "style"] as const;

// hast-util-sanitize matches property names (`className`, `dataLine`) and only
// supports the special `data*` entry for the whole data-attribute family.
const CODE_ROW_HAST_ATTRS = ["className", "style", "data*"] as const;

/**
 * Tags whose entire subtree is removed on both paths instead of being
 * unwrapped. Mirrors DOMPurify's `DEFAULT_FORBID_CONTENTS` (dompurify 3.4.16,
 * the version this repo pins) so the DOM-free rehype pipeline and DOMPurify
 * agree on `svg`/`template`/`iframe`/`thead`-style subtrees: `<svg><text>B</text></svg>`
 * must become empty on Node exactly as it does in the browser. Tags outside
 * this set keep their content on both paths (KEEP_CONTENT semantics).
 */
const CODE_ROW_STRIP_TAGS = [
  "annotation-xml",
  "audio",
  "colgroup",
  "desc",
  "foreignobject",
  "head",
  "iframe",
  "math",
  "mi",
  "mn",
  "mo",
  "ms",
  "mtext",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
  "script",
  "selectedcontent",
  "style",
  "svg",
  "template",
  "thead",
  "title",
  "video",
  "xmp",
];

/**
 * Code-row style policy: only theme wiring survives. Properties must be
 * `--custom-properties` or a small presentational allowlist, and values must
 * stay inside a conservative charset. This rejects CSS backslash escapes
 * (for example a `\75` escape spelling `u`), comment-splitting tricks, and
 * function values such as `url(`/`expression(` by construction instead of
 * pattern-matching raw text. Applied to both paths (rehype tree walk on the
 * DOM-free path, template scrub after DOMPurify in the browser) so browser
 * and Node keep and drop the same styles.
 */
const CODE_ROW_STYLE_PROPS =
  /^(?:--[a-z0-9_-]+|color|background-color|font-synthesis|font-style|font-weight|text-decoration|text-decoration-color|text-decoration-line|text-decoration-style|text-decoration-thickness|display|white-space)$/i;
const CODE_ROW_STYLE_VALUE = /^[a-z0-9#%.,\s_+-]+$/i;


export function isSafeStyleDeclaration(property: string, value: string): boolean {
  return CODE_ROW_STYLE_PROPS.test(property.trim()) && CODE_ROW_STYLE_VALUE.test(value.trim());
}

export function sanitizeStyle(style: string): string {
  const kept: string[] = [];
  for (const declaration of style.split(";")) {
    const trimmed = declaration.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;
    const property = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (isSafeStyleDeclaration(property, value)) {
      kept.push(`${property}: ${value}`);
    }
  }
  return kept.join("; ");
}

export function sanitizeHastStyles(node: unknown): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record.type === "element" && record.properties && typeof record.properties === "object") {
    const properties = record.properties as Record<string, unknown>;
    const style = properties.style;
    if (typeof style === "string") {
      const sanitized = sanitizeStyle(style);
      if (sanitized.length > 0) {
        properties.style = sanitized;
      } else {
        delete properties.style;
      }
    }
  }
  if (Array.isArray(record.children)) {
    for (const child of record.children) sanitizeHastStyles(child);
  }
}

export function isSafeCodeRowStyle(style: string): boolean {
  for (const declaration of style.split(";")) {
    const trimmed = declaration.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) return false;
    const property = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!isSafeStyleDeclaration(property, value)) {
      return false;
    }
  }
  return true;
}

function createCodeRowSchema(): Schema {
  const base = JSON.parse(JSON.stringify(defaultSchema)) as Schema;
  base.tagNames = [...CODE_ROW_ALLOWED_TAGS];
  base.attributes = { "*": [...CODE_ROW_HAST_ATTRS] } as Schema["attributes"];
  base.protocols = {};
  base.strip = [...CODE_ROW_STRIP_TAGS];
  return base;
}

const codeRowProcessor = unified()
  .use(rehypeParsePlugin, { fragment: true })
  .use(rehypeSanitizePlugin, createCodeRowSchema())
  .use(rehypeStringifyPlugin)
  .freeze();

function stripUnsafeCodeRowStyles(node: unknown): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record.type === "element" && record.properties && typeof record.properties === "object") {
    const properties = record.properties as Record<string, unknown>;
    const style = properties.style;
    if (typeof style === "string" && !isSafeCodeRowStyle(style)) {
      delete properties.style;
    }
  }
  if (Array.isArray(record.children)) {
    for (const child of record.children) stripUnsafeCodeRowStyles(child);
  }
}

/**
 * DOM-free code-row sanitizer used by Node/SSR consumers (`sanitizeCodeHTML`).
 * Reuses the worker/server rehype pipeline with the shared code-row allowlist;
 * it never widens tags/attributes and returns "" on failure so callers fall
 * back to their escaped-source path.
 */
export function sanitizeCodeHtmlInWorker(html: string): string {
  if (!html) return "";
  try {
    const tree = codeRowProcessor.runSync(codeRowProcessor.parse(html));
    stripUnsafeCodeRowStyles(tree);
    return String(codeRowProcessor.stringify(tree));
  } catch (error) {
    console.warn("[markdown-v2] Failed to sanitize code HTML without a DOM:", error);
    return "";
  }
}

export function sanitizeHtmlInWorker(html: string, options?: HtmlOptions): string {
  if (!html) return "";
  if (options?.mode === "literal") return html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const source = options?.unmatchedAnchors === "literal-bare" ? escapeUnmatchedBareAnchors(html) : html;
  try {
    return getHtmlProcessor(options).processSync(source).toString();
  } catch (error) {
    console.warn("[markdown-v2] Failed to sanitize HTML in worker:", error);
    return "";
  }
}

type TreeSanitize = (html: string) => unknown;

const defaultHtmlProcessor = createHtmlProcessor();
const htmlProcessors = new WeakMap<object, typeof defaultHtmlProcessor>();

function getHtmlProcessor(options?: HtmlOptions) {
  if (!options) return defaultHtmlProcessor;
  let processor = htmlProcessors.get(options);
  if (!processor) {
    processor = createHtmlProcessor(options);
    htmlProcessors.set(options, processor);
  }
  return processor;
}

export function findUnmatchedBareAnchorOffsets(source: string): number[] {
  const tagPattern = /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z](?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
  const anchors: Array<number | null> = [];
  const unmatched: number[] = [];
  let rawTextTag: string | undefined;
  let offset = 0;
  while (offset < source.length) {
    if (rawTextTag) {
      const rawTextClose = new RegExp(`</${rawTextTag}\\s*>`, "gi");
      rawTextClose.lastIndex = offset;
      const close = rawTextClose.exec(source);
      if (!close) break;
      offset = rawTextClose.lastIndex;
      rawTextTag = undefined;
      continue;
    }
    tagPattern.lastIndex = offset;
    const match = tagPattern.exec(source);
    if (!match) break;
    offset = tagPattern.lastIndex;
    const tag = match[0];
    if (tag.startsWith("<!--")) continue;
    const name = /^<\/?([A-Za-z][\w:-]*)/.exec(tag)?.[1]?.toLowerCase();
    if (!name) continue;
    const closing = tag.startsWith("</");
    if (!closing && ["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "plaintext"].includes(name)) {
      rawTextTag = name;
      continue;
    }
    if (name !== "a") continue;
    if (closing) {
      anchors.pop();
    } else {
      const bareAnchor = /^<a\s*\/?\s*>$/i.test(tag);
      const selfClosing = tag.endsWith("/>");
      if (bareAnchor && selfClosing) unmatched.push(match.index);
      else if (bareAnchor) anchors.push(match.index);
      else if (!selfClosing) anchors.push(null);
    }
  }
  for (const offset of anchors) {
    if (offset !== null) unmatched.push(offset);
  }
  unmatched.sort((left, right) => left - right);
  return unmatched;
}

function escapeUnmatchedBareAnchors(source: string): string {
  const unmatched = findUnmatchedBareAnchorOffsets(source);
  if (unmatched.length === 0) return source;
  let result = "";
  let from = 0;
  for (const offset of unmatched) {
    result += `${source.slice(from, offset)}&lt;`;
    from = offset + 1;
  }
  return result + source.slice(from);
}

function createHtmlProcessor(options?: HtmlOptions, markerAttribute?: string) {
  const schema = createSchema(options);
  const urlTransform = createProtocolPolicyUrlTransform(options?.sanitization?.protocols);
  if (markerAttribute) {
    schema.attributes = {
      ...schema.attributes,
      "*": [...(schema.attributes?.["*"] ?? []), markerAttribute],
    };
  }
  return unified()
    .use(rehypeParsePlugin, { fragment: true })
    .use(() => (tree) => preserveImageTitle(tree))
    .use(rehypeSanitizePlugin, schema)
    .use(() => (tree) => {
      sanitizeHastStyles(tree);
      sanitizeHastUrlProtocols(tree, urlTransform);
      stripConfiguredAttributes(tree, options?.sanitization?.stripAttributes);
    })
    .use(rehypeStringifyPlugin)
    .freeze();
}

function preserveImageTitle(node: unknown): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record.type === "element" && record.tagName === "img" && record.properties && typeof record.properties === "object") {
    const properties = record.properties as Record<string, unknown>;
    if (typeof properties.title === "string") properties.dataMarkdownTitle = properties.title;
  }
  if (Array.isArray(record.children)) {
    for (const child of record.children) preserveImageTitle(child);
  }
}

function sanitizeHastUrlProtocols(
  node: unknown,
  transform: (url: string, attribute: "href" | "src", context: { source: "html" }) => string | null | undefined,
): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record.type === "element" && record.properties && typeof record.properties === "object") {
    const properties = record.properties as Record<string, unknown>;
    for (const attribute of ["href", "src"] as const) {
      const value = properties[attribute];
      if (typeof value !== "string") continue;
      const safe = transform(value, attribute, { source: "html" });
      if (safe === null || safe === undefined) delete properties[attribute];
      else properties[attribute] = safe;
    }
  }
  if (Array.isArray(record.children)) {
    for (const child of record.children) sanitizeHastUrlProtocols(child, transform);
  }
}

function stripConfiguredAttributes(node: unknown, stripped?: readonly string[]): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record.type === "element" && record.properties && typeof record.properties === "object" && stripped?.length) {
    const properties = record.properties as Record<string, unknown>;
    for (const attribute of stripped) {
      const property = toHastAttributeName(attribute.toLowerCase());
      delete properties[property];
      delete properties[attribute];
    }
  }
  if (Array.isArray(record.children)) {
    for (const child of record.children) stripConfiguredAttributes(child, stripped);
  }
}

// Schema construction deep-copies the default schema; cached per serializable config.
const treeSanitizers = new WeakMap<object, Map<string, TreeSanitize>>();
const DEFAULT_ALLOWED_TAGS_KEY = {};

function getTreeSanitizer(options: HtmlOptions | undefined, markerAttribute: string | undefined): TreeSanitize {
  const optionsKey = options ?? DEFAULT_ALLOWED_TAGS_KEY;
  let byMarker = treeSanitizers.get(optionsKey);
  if (!byMarker) {
    byMarker = new Map();
    treeSanitizers.set(optionsKey, byMarker);
  }
  const markerKey = markerAttribute ?? "";
  let sanitize = byMarker.get(markerKey);
  if (!sanitize) {
    const processor = createHtmlProcessor(options, markerAttribute);
    sanitize = (html) => processor.runSync(processor.parse(
      options?.unmatchedAnchors === "literal-bare" ? escapeUnmatchedBareAnchors(html) : html,
    ));
    byMarker.set(markerKey, sanitize);
  }
  return sanitize;
}


/**
 * Parse and sanitize a complete ownership region, never independent opening fragments.
 * Internal block markers are chosen outside user source and removed before rendering.
 */
export function sanitizeHtmlTreeInWorker(
  html: string,
  options?: HtmlOptions,
  marker?: { attribute: string; blocks?: Block[]; inline?: InlineNode[] },
  parseInline?: (text: string) => InlineNode[],
): HtmlTreeNode[] {
  if (options?.mode === "literal") return [{ kind: "text", text: html }];
  const tree = getTreeSanitizer(options, marker?.attribute)(html);
  type HtmlAst = {
    type: string;
    value?: string;
    tagName?: string;
    properties?: Record<string, unknown>;
    children?: HtmlAst[];
    position?: { start: { offset?: number } };
  };
  const convert = (node: HtmlAst, literal = false): HtmlTreeNode[] => {
    if (node.type === "text") {
      const text = node.value ?? "";
      return [{
        kind: "text", text,
        ...(parseInline && options?.literalTagContent !== undefined && !literal ? { inline: parseInline(text) } : {}),
      }];
    }
    if (node.type !== "element") return (node.children ?? []).flatMap((child) => convert(child, literal));
    const tag = node.tagName ?? "span";
    const isLiteral = literal || ["pre", "code", "textarea", ...(options?.literalTagContent ?? [])]
      .some((name) => name.toLowerCase() === tag);
    const attributes: Record<string, string> = {};
    let inlineNode: InlineNode | undefined;
    let paragraphRoot = false;
    for (const [name, value] of Object.entries(node.properties ?? {})) {
      if (marker && name === marker.attribute) {
        if (String(value) === "paragraph") paragraphRoot = true;
        const block = marker.blocks?.[Number(value)];
        if (block) return [{ kind: "block", block }];
        inlineNode = marker.inline?.[Number(value)];
        continue;
      }
      if (isForbiddenAttribute(name)) continue;
      if (value !== null && value !== undefined && value !== false) {
        attributes[name] = Array.isArray(value) ? value.join(" ") : value === true ? "" : String(value);
      }
    }
    return [{
      kind: "element",
      tagName: node.tagName ?? "span",
      attributes,
      ...(inlineNode ? { inlineNode: inlineNode.kind === "link" ? { ...inlineNode, href: attributes.href } : inlineNode } : {}),
      ...(paragraphRoot ? { paragraphRoot: true } : {}),
      children: (node.children ?? []).flatMap((child) => convert(child, isLiteral)),
    }];
  };
  return convert(tree as HtmlAst);
}

function createSchema(options?: HtmlOptions): Schema {
  const base = JSON.parse(JSON.stringify(defaultSchema)) as Schema;
  const customAllowedTags = options?.allowedTags;
  const policy = options?.sanitization;
  const tagSet = new Set<string>(policy?.tagNames?.map((tag) => tag.toLowerCase()) ?? base.tagNames ?? []);
  const defaultTags = [
    "div", "span", "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "em", "u", "s", "del", "ins", "blockquote", "pre", "code", "ul", "ol", "li",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "a", "img", "section", "article",
    "aside", "nav", "header", "footer", "main", "annotation", "semantics", "mtext", "mn", "mo",
    "mi", "mspace", "mrow", "mfrac", "msup", "msub", "msubsup", "munder", "mover",
    "munderover", "msqrt", "mroot", "mtable", "mtr", "mtd", "sub", "sup", "kbd", "textarea",
  ];
  if (!policy?.tagNames) {
    for (const tag of defaultTags) tagSet.add(tag);
    for (const tag of Object.keys(customAllowedTags ?? {})) tagSet.add(tag.toLowerCase());
  }
  tagSet.delete("script");
  tagSet.delete("style");
  base.tagNames = Array.from(tagSet);

  const customAttrs: Record<string, AttributeDefinition[]> = {};
  if (customAllowedTags && !policy?.attributes) {
    for (const [tag, attrs] of Object.entries(customAllowedTags)) {
      customAttrs[tag.toLowerCase()] = attrs.filter((attr) => !isForbiddenAttribute(attr)).flatMap((attr) => {
        const camel = attr.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
        return camel === attr ? [attr] : [attr, camel];
      });
    }
  }
  if (policy?.attributes) {
    const attributes: Record<string, AttributeDefinition[]> = {};
    for (const [tag, names] of Object.entries(policy.attributes)) {
      const key = tag === "*" ? "*" : tag.toLowerCase();
      attributes[key] = names.filter((name) => !isForbiddenAttribute(name)).map((name) => toHastAttributeName(name.toLowerCase()));
    }
    attributes.img = mergeAttributes(attributes.img, ["dataMarkdownTitle"]);
    base.attributes = attributes as Schema["attributes"];
  } else {
    base.attributes = {
      ...(base.attributes || {}),
      "*": customAllowedTags && Object.keys(customAllowedTags).length > 0
        ? mergeAttributes(base.attributes?.["*"] as AttributeDefinition[] | undefined, ["className", "id", "title", "style"])
        : mergeAttributes(base.attributes?.["*"] as AttributeDefinition[] | undefined, ["className", "id", "title", "style", "data-*", "aria-*"]),
      a: mergeAttributes(base.attributes?.a as AttributeDefinition[] | undefined, ["href", "title", "target", "rel"]),
      img: mergeAttributes(base.attributes?.img as AttributeDefinition[] | undefined, ["src", "alt", "title", "dataMarkdownTitle"]),
      table: mergeAttributes(base.attributes?.table as AttributeDefinition[] | undefined, ["align", "border", "cellpadding", "cellspacing"]),
      th: mergeAttributes(base.attributes?.th as AttributeDefinition[] | undefined, ["align", "colspan", "rowspan"]),
      td: mergeAttributes(base.attributes?.td as AttributeDefinition[] | undefined, ["align", "colspan", "rowspan"]),
      tr: mergeAttributes(base.attributes?.tr as AttributeDefinition[] | undefined, ["align"]),
      ...customAttrs,
    } as Schema["attributes"];
  }
  if (base.attributes) delete (base.attributes as Record<string, unknown>)["script"];
  base.protocols = {
    ...(base.protocols || {}),
    href: policy?.protocols?.href ?? ["http", "https", "mailto", "tel", "callto"],
    src: policy?.protocols?.src ?? ["http", "https", "data"],
  };
  base.strip = ["script", "style"];
  return base;
}

function toHastAttributeName(attribute: string): string {
  if (attribute === "data-*") return "data*";
  if (attribute === "aria-*") return "aria*";
  if (attribute === "class") return "className";
  if (attribute === "for") return "htmlFor";
  return attribute.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function mergeAttributes(existing: AttributeDefinition[] | undefined, additions: string[]): AttributeDefinition[] {
  const next: AttributeDefinition[] = Array.isArray(existing)
    ? existing.filter((e) => typeof e !== "string" || !isForbiddenAttribute(e))
    : [];
  const existingStrings = new Set<string>();
  for (const entry of next) {
    if (typeof entry === "string") {
      existingStrings.add(entry);
    }
  }
  for (const attr of additions) {
    if (!existingStrings.has(attr) && !isForbiddenAttribute(attr)) {
      next.push(attr);
      existingStrings.add(attr);
    }
  }
  return next;
}
