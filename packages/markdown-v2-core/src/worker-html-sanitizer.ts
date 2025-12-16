import rehypeParse from "rehype-parse";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";

type Schema = typeof defaultSchema;
type AttributeDefinition = string | [string, ...(string | number | boolean | RegExp | null | undefined)[]];

const SANITIZED_SCHEMA: Schema = createSchema();

const sanitizeProcessor = unified().use(rehypeParse, { fragment: true }).use(rehypeSanitize, SANITIZED_SCHEMA).use(rehypeStringify).freeze();

export function sanitizeHtmlInWorker(html: string): string {
  if (!html) return "";
  try {
    return sanitizeProcessor.processSync(html).toString();
  } catch (error) {
    console.warn("[markdown-v2] Failed to sanitize HTML in worker:", error);
    return "";
  }
}

function createSchema(): Schema {
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
  ];
  for (const tag of allowedTags) {
    tagSet.add(tag);
  }
  base.tagNames = Array.from(tagSet);

  base.attributes = {
    ...(base.attributes || {}),
    "*": mergeAttributes(base.attributes?.["*"] as AttributeDefinition[] | undefined, ["className", "id", "title", "style", "data-*", "aria-*"]),
    a: mergeAttributes(base.attributes?.a as AttributeDefinition[] | undefined, ["href", "title", "target", "rel"]),
    img: mergeAttributes(base.attributes?.img as AttributeDefinition[] | undefined, ["src", "alt", "title"]),
    table: mergeAttributes(base.attributes?.table as AttributeDefinition[] | undefined, ["align", "border", "cellpadding", "cellspacing"]),
    th: mergeAttributes(base.attributes?.th as AttributeDefinition[] | undefined, ["align", "colspan", "rowspan"]),
    td: mergeAttributes(base.attributes?.td as AttributeDefinition[] | undefined, ["align", "colspan", "rowspan"]),
    tr: mergeAttributes(base.attributes?.tr as AttributeDefinition[] | undefined, ["align"]),
  } as Schema["attributes"];

  base.protocols = {
    ...(base.protocols || {}),
    href: ["http", "https", "mailto", "tel", "callto"],
    src: ["http", "https", "data"],
  };

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
