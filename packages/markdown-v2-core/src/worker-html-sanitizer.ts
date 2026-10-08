import * as rehypeParse from "rehype-parse";
import * as rehypeSanitize from "rehype-sanitize";
import * as rehypeStringify from "rehype-stringify";
import { type Plugin, unified } from "unified";
import type { Block, HtmlOptions, HtmlTreeNode, InlineNode } from "./types";

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

const SANITIZED_SCHEMA: Schema = createSchema();

const sanitizeProcessor = unified()
  .use(rehypeParsePlugin, { fragment: true })
  .use(rehypeSanitizePlugin, SANITIZED_SCHEMA)
  .use(rehypeStringifyPlugin)
  .freeze();

export function sanitizeHtmlInWorker(html: string, options?: { allowedTags?: Record<string, string[]> }): string {
  if (!html) return "";
  if (options?.allowedTags && Object.keys(options.allowedTags).length > 0) {
    const schema = createSchema(options.allowedTags);
    const customProcessor = unified()
      .use(rehypeParsePlugin, { fragment: true })
      .use(rehypeSanitizePlugin, schema)
      .use(rehypeStringifyPlugin)
      .freeze();
    try {
      return customProcessor.processSync(html).toString();
    } catch (error) {
      console.warn("[markdown-v2] Failed to sanitize HTML in worker with custom tags:", error);
      return "";
    }
  }
  try {
    return sanitizeProcessor.processSync(html).toString();
  } catch (error) {
    console.warn("[markdown-v2] Failed to sanitize HTML in worker:", error);
    return "";
  }
}

/**
 * Parse and sanitize a complete ownership region, never independent opening fragments.
 * Internal block markers are chosen outside user source and removed before rendering.
 */
export function sanitizeHtmlTreeInWorker(
  html: string,
  options?: HtmlOptions,
  marker?: { attribute: string; blocks: Block[] },
  parseInline?: (text: string) => InlineNode[],
): HtmlTreeNode[] {
  const schema = createSchema(options?.allowedTags);
  if (marker) {
    schema.attributes = {
      ...schema.attributes,
      "*": [...(schema.attributes?.["*"] ?? []), marker.attribute],
    };
  }
  const processor = unified().use(rehypeParsePlugin, { fragment: true }).use(rehypeSanitizePlugin, schema);
  const tree = processor.runSync(processor.parse(html));
  type HtmlAst = {
    type: string;
    value?: string;
    tagName?: string;
    properties?: Record<string, unknown>;
    children?: HtmlAst[];
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
    for (const [name, value] of Object.entries(node.properties ?? {})) {
      if (marker && name === marker.attribute) {
        const block = marker.blocks[Number(value)];
        if (block) return [{ kind: "block", block }];
      }
      if (value !== null && value !== undefined && value !== false) {
        attributes[name] = Array.isArray(value) ? value.join(" ") : value === true ? "" : String(value);
      }
    }
    return [{
      kind: "element",
      tagName: node.tagName ?? "span",
      attributes,
      children: (node.children ?? []).flatMap((child) => convert(child, isLiteral)),
    }];
  };
  return convert(tree as HtmlAst);
}

function createSchema(customAllowedTags?: Record<string, string[]>): Schema {
  const base = JSON.parse(JSON.stringify(defaultSchema)) as Schema;
  const tagSet = new Set<string>(base.tagNames ?? []);
  const allowedTags = [
    "div",
    "span",
    "p",
    "br",
    "hr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "strong",
    "em",
    "u",
    "s",
    "del",
    "ins",
    "blockquote",
    "pre",
    "code",
    "ul",
    "ol",
    "li",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "a",
    "img",
    "section",
    "article",
    "aside",
    "nav",
    "header",
    "footer",
    "main",
    "annotation",
    "semantics",
    "mtext",
    "mn",
    "mo",
    "mi",
    "mspace",
    "mrow",
    "mfrac",
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
    "sub",
    "sup",
    "kbd",
    "textarea",
  ];
  for (const tag of allowedTags) {
    tagSet.add(tag);
  }
  if (customAllowedTags) {
    for (const tag of Object.keys(customAllowedTags)) {
      tagSet.add(tag.toLowerCase());
    }
  }
  tagSet.delete("script");
  tagSet.delete("style");
  base.tagNames = Array.from(tagSet);

  const customAttrs: Record<string, AttributeDefinition[]> = {};
  if (customAllowedTags) {
    for (const [tag, attrs] of Object.entries(customAllowedTags)) {
      const lowerTag = tag.toLowerCase();
      const attrDefs: string[] = [];
      for (const a of attrs) {
        attrDefs.push(a);
        const camel = a.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (camel !== a) {
          attrDefs.push(camel);
        }
      }
      customAttrs[lowerTag] = attrDefs;
    }
  }

  base.attributes = {
    ...(base.attributes || {}),
    "*": customAllowedTags && Object.keys(customAllowedTags).length > 0
      ? mergeAttributes(base.attributes?.["*"] as AttributeDefinition[] | undefined, ["className", "id", "title", "style"])
      : mergeAttributes(base.attributes?.["*"] as AttributeDefinition[] | undefined, ["className", "id", "title", "style", "data-*", "aria-*"]),
    a: mergeAttributes(base.attributes?.a as AttributeDefinition[] | undefined, ["href", "title", "target", "rel"]),
    img: mergeAttributes(base.attributes?.img as AttributeDefinition[] | undefined, ["src", "alt", "title"]),
    table: mergeAttributes(base.attributes?.table as AttributeDefinition[] | undefined, ["align", "border", "cellpadding", "cellspacing"]),
    th: mergeAttributes(base.attributes?.th as AttributeDefinition[] | undefined, ["align", "colspan", "rowspan"]),
    td: mergeAttributes(base.attributes?.td as AttributeDefinition[] | undefined, ["align", "colspan", "rowspan"]),
    tr: mergeAttributes(base.attributes?.tr as AttributeDefinition[] | undefined, ["align"]),
    ...customAttrs,
  } as Schema["attributes"];
  base.protocols = {
    ...(base.protocols || {}),
    href: ["http", "https", "mailto", "tel", "callto"],
    src: ["http", "https", "data"],
  };

  base.strip = ["script", "style"];

  return base;
}

function mergeAttributes(existing: AttributeDefinition[] | undefined, additions: string[]): AttributeDefinition[] {
  const next: AttributeDefinition[] = Array.isArray(existing) ? [...existing] : [];
  const existingStrings = new Set<string>();
  for (const entry of next) {
    if (typeof entry === "string") {
      existingStrings.add(entry);
    }
  }
  for (const attr of additions) {
    if (!existingStrings.has(attr)) {
      next.push(attr);
      existingStrings.add(attr);
    }
  }
  return next;
}
