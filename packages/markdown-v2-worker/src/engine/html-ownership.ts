import type { MarkdownParser } from "@lezer/markdown";
import { dedentIndentedCode, sanitizeHtmlTreeInWorker, stripCodeFence, type Block, type HtmlOptions, type InlineNode, type MarkdownElement } from "@stream-mdx/core";

const VOID: Record<string, true> = { area: true, base: true, br: true, col: true, embed: true, hr: true, img: true, input: true, link: true, meta: true, param: true, source: true, track: true, wbr: true };
const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function inlineHtml(nodes: InlineNode[]): string {
  return nodes.map((node): string => {
    switch (node.kind) {
      case "text": return escapeHtml(node.text);
      case "code": return `<code>${escapeHtml(node.text)}</code>`;
      case "br": return "<br>\n";
      case "strong": return `<strong>${inlineHtml(node.children)}</strong>`;
      case "em": return `<em>${inlineHtml(node.children)}</em>`;
      case "strike": return `<del>${inlineHtml(node.children)}</del>`;
      case "link": return `<a${node.href === undefined ? "" : ` href="${escapeHtml(node.href)}"`}>${inlineHtml(node.children)}</a>`;
      case "image": return `<img src="${escapeHtml(node.src)}" alt="${escapeHtml(node.alt ?? "")}">`;
      case "html": {
        if (node.isClose) return node.raw;
        if (!node.tagName || node.tagName === "script" || node.tagName === "style") return "";
        const attrs = Object.entries(node.attributes ?? {}).map(([key, value]) => ` ${key === "className" ? "class" : key}="${escapeHtml(value)}"`).join("");
        return `<${node.tagName}${attrs}>${node.isSelfClosing ? "" : `${inlineHtml(node.children ?? [])}</${node.tagName}>`}`;
      }
      case "plugin": return node.children ? inlineHtml(node.children) : escapeHtml(node.raw);
      case "math-inline": case "math-display": return escapeHtml(node.tex);
      case "mention": return escapeHtml(`@${node.handle}`);
      case "citation": return escapeHtml(node.id);
      case "footnote-ref": return escapeHtml(`[^${node.label}]`);
    }
  }).join("");
}

function blockHtml(block: Block, attribute: string, index: number): string {
  const marker = ` ${attribute}="${index}"`;
  const meta = block.payload.meta ?? {};
  if (block.type === "code") {
    const code = typeof meta.code === "string" ? meta.code : /^\s*(```|~~~)/.test(block.payload.raw) ? stripCodeFence(block.payload.raw).code : dedentIndentedCode(block.payload.raw);
    return `<pre${marker}><code>${escapeHtml(code.replace(/\n?$/, "\n"))}</code></pre>`;
  }
  const tag = block.type === "heading" ? `h${meta.headingLevel ?? 1}` : block.type === "hr" ? "hr" : block.type === "blockquote" ? "blockquote" : block.type === "list" ? (meta.ordered ? "ol" : "ul") : "p";
  return `<${tag}${marker}>${inlineHtml(block.payload.inline ?? [])}</${tag}>`;
}

/** Own an open HTML container across Lezer block boundaries, retaining markdown leaves. */
export function groupHtmlOwnership(blocks: Block[], parser: MarkdownParser, content: string, options?: HtmlOptions, sourceOffset = 0, parseInline?: (text: string) => InlineNode[]): Block[] {
  const result: Block[] = [];
  let region: Block[] = [];
  let stack: string[] = [];
  const updateStack = (raw: string) => {
    const visit = (elements: readonly MarkdownElement[]) => {
      for (const element of elements) {
        if (parser.nodeSet.types[element.type].name === "HTMLTag") {
          const tag = raw.slice(element.from, element.to);
          const name = /^<\/?([a-zA-Z][^\s/>]*)/.exec(tag)?.[1]?.toLowerCase();
          if (!name) continue;
          if (tag.startsWith("</")) {
            const at = stack.lastIndexOf(name);
            if (at >= 0) stack.length = at;
          } else if (!VOID[name] && !tag.endsWith("/>")) {
            stack.push(name);
          }
        }
        if (element.children.length) visit(element.children);
      }
    };
    visit(parser.parseInline(raw, 0) as readonly MarkdownElement[]);
  };
  const flush = () => {
    if (region.length === 1) {
      result.push(region[0]);
    } else if (region.length > 1) {
      const first = region[0];
      let attribute = "smdxblock";
      while (content.toLowerCase().includes(attribute)) attribute += "x";
      const markdown: Block[] = [];
      const html = region.map((block) => {
        if (block.type === "html") return block.payload.raw;
        const index = markdown.push(block) - 1;
        return blockHtml(block, attribute, index);
      }).join("\n");
      const last = region[region.length - 1];
      result.push({
        ...first,
        isFinalized: stack.length === 0 && last.isFinalized,
        payload: {
          ...first.payload,
          raw: content.slice((first.payload.range?.from ?? sourceOffset) - sourceOffset, (last.payload.range?.to ?? content.length + sourceOffset) - sourceOffset),
          range: { from: first.payload.range?.from ?? sourceOffset, to: last.payload.range?.to ?? content.length + sourceOffset },
          meta: { ...first.payload.meta, htmlTree: sanitizeHtmlTreeInWorker(html, options, { attribute, blocks: markdown }, parseInline), htmlOwnership: true },
        },
      });
    }
    region = [];
    stack = [];
  };
  for (const block of blocks) {
    if (region.length === 0 && block.type !== "html") {
      result.push(block);
      continue;
    }
    updateStack(block.payload.raw);
    if (region.length === 0 && stack.length === 0) {
      result.push(block);
      continue;
    }
    region.push(block);
    if (stack.length === 0) flush();
  }
  flush();
  return result;
}
