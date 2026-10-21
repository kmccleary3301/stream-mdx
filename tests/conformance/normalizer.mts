import { fromHtml } from "hast-util-from-html";
import type { Element, Nodes, Text } from "hast";

export type SemanticNode =
  | {
      type: "element";
      tag: string;
      attrs: Record<string, string>;
      children: SemanticNode[];
    }
  | {
      type: "text";
      value: string;
    };
export interface NormalizerOptions {
  strict?: boolean;
}

const PRUNED_TAGS: Record<string, true> = {
  button: true,
  svg: true,
  path: true,
  polygon: true,
  circle: true,
  rect: true,
  line: true,
  g: true,
  defs: true,
  clippath: true,
  mask: true,
  style: true,
  script: true,
  meta: true,
  link: true,
  head: true,
  title: true,
};

const SEMANTIC_TAGS: Record<string, true> = {
  p: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  em: true,
  strong: true,
  del: true,
  code: true,
  pre: true,
  a: true,
  img: true,
  ul: true,
  ol: true,
  li: true,
  blockquote: true,
  table: true,
  thead: true,
  tbody: true,
  tr: true,
  th: true,
  td: true,
  hr: true,
  br: true,
  input: true,
};

const BLOCK_TAGS: Record<string, true> = {
  p: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  pre: true,
  blockquote: true,
  ul: true,
  ol: true,
  li: true,
  table: true,
  thead: true,
  tbody: true,
  tr: true,
  th: true,
  td: true,
  hr: true,
};

function normalizeUri(uri: string): string {
  try {
    return encodeURI(decodeURI(uri));
  } catch {
    return uri;
  }
}

function extractAlign(properties: Record<string, unknown>): string | undefined {
  if (typeof properties.align === "string") {
    const align = properties.align.toLowerCase();
    if (align === "left" || align === "center" || align === "right") {
      return align;
    }
  }
  if (typeof properties.style === "string") {
    const match = /text-align\s*:\s*(left|center|right)/i.exec(properties.style);
    if (match) {
      return match[1].toLowerCase();
    }
  }
  return undefined;
}

function isPrunedElement(el: Element): boolean {
  const tagName = el.tagName.toLowerCase();
  if (PRUNED_TAGS[tagName]) return true;

  const dataStreamdown = el.properties?.dataStreamdown ?? el.properties?.["data-streamdown"];
  return (
    dataStreamdown === "code-block-header" ||
    dataStreamdown === "codeBlockHeader" ||
    dataStreamdown === "code-block-actions" ||
    dataStreamdown === "codeBlockActions" ||
    dataStreamdown === "copy-button" ||
    dataStreamdown === "copyButton"
  );
}

function textContent(node: Nodes): string {
  if (node.type === "text") return (node as Text).value;
  if (node.type === "element" && isPrunedElement(node as Element)) return "";
  if ("children" in node && Array.isArray(node.children)) {
    return (node.children as Nodes[]).map(textContent).join("");
  }
  return "";
}

function findDescendant(node: Nodes, tag: string): Element | null {
  if (node.type === "element" && (node as Element).tagName.toLowerCase() === tag) return node as Element;
  if ("children" in node && Array.isArray(node.children)) {
    for (const child of node.children as Nodes[]) {
      const found = findDescendant(child, tag);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Code block text. Highlighters wrap each line in a span; some join lines with "\n"
 * (Shiki HTML) and some rely on CSS `display:block` (Streamdown). When every non-blank
 * child of <code> is a span, lines are joined with "\n". Trailing newlines are dropped
 * for every renderer, including the spec HTML.
 */
function codeBlockText(pre: Element): string {
  const code = findDescendant(pre, "code") ?? pre;
  const children = code.children as Nodes[];
  const lineSpans = children.filter((child) => child.type === "element");
  const strayText = children.some((child) => child.type === "text" && (child as Text).value.replace(/\n/g, "") !== "");
  const isLineWrapped =
    lineSpans.length > 0 && !strayText && lineSpans.every((child) => (child as Element).tagName.toLowerCase() === "span");
  const text = isLineWrapped ? lineSpans.map(textContent).join("\n") : textContent(code);
  return text.replace(/\n+$/, "");
}
function extractCodeLanguage(node: Nodes): string | undefined {
  if (node.type !== "element") return undefined;
  const el = node as Element;
  const classNames = Array.isArray(el.properties?.className)
    ? el.properties.className.map(String)
    : [];
  for (const cls of classNames) {
    if (cls.startsWith("language-") && cls.length > "language-".length) {
      return cls;
    }
  }
  const dataLang = el.properties?.dataLanguage ?? el.properties?.["data-language"];
  if (typeof dataLang === "string" && dataLang.trim()) {
    return `language-${dataLang.trim()}`;
  }
  if ("children" in el && Array.isArray(el.children)) {
    for (const child of el.children as Nodes[]) {
      const found = extractCodeLanguage(child);
      if (found) return found;
    }
  }
  return undefined;
}


function processHastChildren(children: Nodes[], inPre: boolean, options?: NormalizerOptions): SemanticNode[] {
  const rawList: SemanticNode[] = [];
  for (const child of children) {
    const converted = convertHastNode(child, inPre, options);
    for (const node of converted) {
      rawList.push(node);
    }
  }
  return normalizeChildList(rawList, inPre);
}

function convertHastNode(node: Nodes, inPre: boolean, options?: NormalizerOptions): SemanticNode[] {
  if (node.type === "comment") return [];

  if (node.type === "text") {
    const textVal = (node as Text).value;
    if (!textVal) return [];
    return [{ type: "text", value: inPre ? textVal : textVal.replace(/\s+/g, " ") }];
  }

  if (node.type === "element") {
    const el = node as Element;
    if (isPrunedElement(el)) return [];

    const tagName = el.tagName.toLowerCase();
    if (tagName === "pre") {
      const text = codeBlockText(el);
      const codeChildren: SemanticNode[] = text ? [{ type: "text", value: text }] : [];
      const codeAttrs: Record<string, string> = {};
      if (options?.strict) {
        const lang = extractCodeLanguage(el);
        if (lang) {
          codeAttrs.class = lang;
        }
      }
      return [{ type: "element", tag: "pre", attrs: {}, children: [{ type: "element", tag: "code", attrs: codeAttrs, children: codeChildren }] }];
    }

    // Checkbox input
    if (tagName === "input") {
      const type = String(el.properties?.type ?? "").toLowerCase();
      if (type !== "checkbox") return [];
      const attrs: Record<string, string> = { type: "checkbox" };
      const checked = el.properties?.checked;
      if (checked === true || checked === "" || checked === "checked") {
        attrs.checked = "checked";
      }
      return [{ type: "element", tag: "input", attrs, children: [] }];
    }

    if (SEMANTIC_TAGS[tagName]) {
      const isPre = tagName === "pre";
      const children = processHastChildren(el.children as Nodes[], inPre || isPre, options);
      const attrs: Record<string, string> = {};

      if (tagName === "a") {
        if (el.properties?.href !== undefined) {
          attrs.href = normalizeUri(String(el.properties.href));
        }
        if (options?.strict && el.properties?.title !== undefined) {
          attrs.title = String(el.properties.title);
        }
      } else if (tagName === "img") {
        if (el.properties?.src !== undefined) {
          attrs.src = normalizeUri(String(el.properties.src));
        }
        if (el.properties?.alt !== undefined) {
          attrs.alt = String(el.properties.alt);
        }
        if (options?.strict && el.properties?.title !== undefined) {
          attrs.title = String(el.properties.title);
        }
      } else if (tagName === "ol") {
        const start = el.properties?.start;
        if (start !== undefined && String(start) !== "1") {
          attrs.start = String(start);
        }
      } else if (tagName === "th" || tagName === "td") {
        const align = extractAlign(el.properties ?? {});
        if (align) {
          attrs.align = align;
        }
      } else if (tagName === "code" && options?.strict) {
        const lang = extractCodeLanguage(el);
        if (lang) {
          attrs.class = lang;
        }
      }
      // A paragraph holding only images is equivalent to the bare images: renderers that wrap
      // images in block chrome (download buttons, figures) must drop the <p> to stay valid HTML.
      if (tagName === "p" && children.length > 0 && children.every((child) => child.type === "element" && child.tag === "img")) {
        return children;
      }

      return [{ type: "element", tag: tagName, attrs, children }];
    }

    // Non-semantic wrapper or unrecognized tag: unwrap children
    return processHastChildren(el.children as Nodes[], inPre, options);
  }

  if ("children" in node && Array.isArray(node.children)) {
    return processHastChildren(node.children as Nodes[], inPre, options);
  }

  return [];
}

function normalizeChildList(nodes: SemanticNode[], inPre: boolean): SemanticNode[] {
  if (inPre) {
    const merged: SemanticNode[] = [];
    for (const node of nodes) {
      if (node.type === "text") {
        const prev = merged[merged.length - 1];
        if (prev && prev.type === "text") {
          prev.value += node.value;
        } else {
          merged.push({ ...node });
        }
      } else {
        merged.push(node);
      }
    }
    return merged;
  }

  // 1. Merge adjacent text nodes and collapse whitespace
  const merged: SemanticNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      const val = node.value.replace(/\s+/g, " ");
      if (!val) continue;
      const prev = merged[merged.length - 1];
      if (prev && prev.type === "text") {
        prev.value = (prev.value + val).replace(/\s+/g, " ");
      } else {
        merged.push({ type: "text", value: val });
      }
    } else {
      merged.push(node);
    }
  }

  // 2. Strip whitespace directly adjacent to block elements or start/end
  if (merged.length > 0 && merged[0].type === "text") {
    merged[0].value = merged[0].value.replace(/^\s+/, "");
    if (!merged[0].value) {
      merged.shift();
    }
  }

  if (merged.length > 0) {
    const last = merged[merged.length - 1];
    if (last.type === "text") {
      last.value = last.value.replace(/\s+$/, "");
      if (!last.value) {
        merged.pop();
      }
    }
  }

  const result: SemanticNode[] = [];
  for (let i = 0; i < merged.length; i++) {
    const curr = merged[i];
    if (curr.type === "text") {
      let val = curr.value;
      const prev = result[result.length - 1];
      const next = merged[i + 1];

      if (prev && prev.type === "element" && BLOCK_TAGS[prev.tag]) {
        val = val.replace(/^\s+/, "");
      }
      if (next && next.type === "element" && BLOCK_TAGS[next.tag]) {
        val = val.replace(/\s+$/, "");
      }
      if (val) {
        result.push({ type: "text", value: val });
      }
    } else {
      result.push(curr);
    }
  }

  return result;
}

export function parseSemanticTree(html: string, options?: NormalizerOptions): SemanticNode[] {
  const hast = fromHtml(html, { fragment: true });
  return processHastChildren(hast.children as Nodes[], false, options);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function serializeSemanticTree(nodes: SemanticNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      out += escapeHtml(node.value);
    } else {
      const { tag, attrs, children } = node;
      out += `<${tag}`;
      const keys = Object.keys(attrs).sort();
      for (const k of keys) {
        out += ` ${k}="${escapeHtml(attrs[k])}"`;
      }
      out += ">";
      if (tag === "hr" || tag === "br" || tag === "img" || tag === "input") {
        continue;
      }
      out += serializeSemanticTree(children);
      out += `</${tag}>`;
    }
  }
  return out;
}

export function normalizeHtmlSemantics(html: string, options?: NormalizerOptions): string {
  return serializeSemanticTree(parseSemanticTree(html, options));
}
