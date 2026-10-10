import type { MarkdownParser } from "@lezer/markdown";
import { dedentIndentedCode, sanitizeHtmlTreeInWorker, stripCodeFence, type Block, type HtmlOptions, type InlineNode } from "@stream-mdx/core";
import { trimProvisionalFenceTail } from "./parse-extract";

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
    const code = typeof meta.code === "string" ? meta.code : /^\s*(```|~~~)/.test(block.payload.raw) ? stripCodeFence(block.isFinalized ? block.payload.raw : trimProvisionalFenceTail(block.payload.raw)).code : dedentIndentedCode(block.payload.raw);
    return `<pre${marker}><code>${escapeHtml(code.replace(/\n?$/, "\n"))}</code></pre>`;
  }
  const tag = block.type === "heading" ? `h${meta.headingLevel ?? 1}` : block.type === "hr" ? "hr" : block.type === "blockquote" ? "blockquote" : block.type === "list" ? (meta.ordered ? "ol" : "ul") : "p";
  return `<${tag}${marker}>${inlineHtml(block.payload.inline ?? [])}</${tag}>`;
}

/**
 * Inline elements produced by Lezer's parser carry their nested children at runtime (see
 * `InlineContext.elt(..., children)`), while the published `Element` type only documents
 * `type`/`from`/`to`. Walk them through this structural view instead of casting through `unknown`.
 */
interface InlineElementView {
  readonly type: number;
  readonly from: number;
  readonly to: number;
  readonly children?: readonly InlineElementView[];
}

/**
 * Apply one raw fragment's Lezer HTMLTag open/close effects to an open-container stack.
 *
 * MDX component names are case-sensitive: `<Input>` and `<Link>` are components, while `<input>` and
 * `<link>` are the HTML void elements. `mdxComponents` is the caller's MDX mode; without it, names
 * take their HTML identity case-insensitively, matching CommonMark's tag handling.
 */
export function applyHtmlTagBalance(raw: string, parser: MarkdownParser, stack: string[], mdxComponents = false): void {
  const visit = (elements: readonly InlineElementView[]) => {
    for (const element of elements) {
      if (parser.nodeSet.types[element.type].name === "HTMLTag") {
        const tag = raw.slice(element.from, element.to);
        const written = /^<\/?([a-zA-Z][^\s/>]*)/.exec(tag)?.[1];
        if (!written) continue;
        const component = /^[A-Z]/.test(written);
        const name = component && mdxComponents ? written : written.toLowerCase();
        if (tag.startsWith("</")) {
          const at = stack.lastIndexOf(name);
          if (at >= 0) stack.length = at;
        } else if ((component && mdxComponents || !VOID[name]) && !tag.endsWith("/>")) {
          stack.push(name);
        }
      }
      if (element.children?.length) visit(element.children);
    }
  };
  visit(parser.parseInline(raw, 0));
}

/**
 * Nested snapshots keep a code leaf's raw as a verbatim source slice, which retains the enclosing
 * container markers (`> x`) for quoted components. Rebuild the joined owner's source from the leaf's
 * native code text and info string so the MDX compiler receives a valid fence; the leaf's own
 * payload and metadata stay untouched.
 */
function codeCompileSource(block: Block): string {
  const meta = block.payload.meta ?? {};
  const code = typeof meta.code === "string" ? meta.code : undefined;
  if (code === undefined) return (block.payload.raw ?? "").replace(/\n$/, "");
  const info = typeof meta.info === "string" ? meta.info : "";
  const content = code.replace(/\n$/, "");
  const longestFence = content.split("\n").reduce((max, line) => Math.max(max, /^`+/.exec(line)?.[0].length ?? 0), 0);
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return `${fence}${info}\n${content}\n${fence}`;
}

/** Own balanced HTML regions across native block boundaries, retaining pending MDX roots. */
export function groupHtmlOwnership(blocks: Block[], parser: MarkdownParser, content: string, options?: HtmlOptions, sourceOffset = 0, parseInline?: (text: string) => InlineNode[], regionOptions?: { joinLeafRaws?: boolean; forceFinalize?: boolean; mdxComponents?: boolean }): Block[] {
  const result: Block[] = [];
  let region: Block[] = [];
  let stack: string[] = [];
  let pendingComponent = false;
  const flush = () => {
    if (stack.length > 0 && !pendingComponent) {
      // An unclosed HTML tag is not evidence that later native paragraphs or lists belong to it.
      // Keep their original blocks and ranges; only an authored close can extend HTML ownership.
      for (const block of region) result.push(block);
    } else if (region.length === 1) {
      result.push(region[0]);
    } else if (region.length > 1) {
      const first = region[0];
      // Only the region's own source reaches the sanitizer, so the private attribute must avoid that
      // source alone (as in `normalizeHtmlParagraph`); scanning the whole document is O(document) per region.
      const regionSource = region.map((block) => block.payload.raw ?? "").join("\n").toLowerCase();
      let attribute = "smdxblock";
      while (regionSource.includes(attribute)) attribute += "x";
      const markdown: Block[] = [];
      const html = region.map((block) => {
        if (block.type === "html") return block.payload.raw;
        const index = markdown.push(block) - 1;
        return blockHtml(block, attribute, index);
      }).join("\n");
      const last = region[region.length - 1];
      const raw = regionOptions?.joinLeafRaws
        ? region.map((block) => (block.type === "code" ? codeCompileSource(block) : (block.payload.raw ?? "").replace(/\n$/, ""))).join("\n\n")
        : content.slice((first.payload.range?.from ?? sourceOffset) - sourceOffset, (last.payload.range?.to ?? content.length + sourceOffset) - sourceOffset);
      result.push({
        ...first,
        isFinalized: (stack.length === 0 || regionOptions?.forceFinalize === true) && last.isFinalized,
        payload: {
          ...first.payload,
          raw,
          range: { from: first.payload.range?.from ?? sourceOffset, to: last.payload.range?.to ?? content.length + sourceOffset },
          meta: { ...first.payload.meta, htmlTree: sanitizeHtmlTreeInWorker(html, options, { attribute, blocks: markdown }, parseInline), htmlOwnership: true },
        },
      });
    }
    region = [];
    stack = [];
    pendingComponent = false;
  };
  for (const block of blocks) {
    if (region.length === 0 && block.type !== "html") {
      result.push(block);
      continue;
    }
    applyHtmlTagBalance(block.payload.raw, parser, stack, regionOptions?.mdxComponents === true);
    if (region.length === 0 && stack.length === 0) {
      result.push(block);
      continue;
    }
    if (region.length === 0) {
      pendingComponent = regionOptions?.mdxComponents === true && /^[A-Z]/.test(stack[0] ?? "");
    }
    region.push(block);
    if (stack.length === 0) flush();
  }
  flush();
  return result;
}

/**
 * Browser reconstruction owns the entire paragraph, not independently auto-closed tag fragments.
 * The private attribute cannot occur in user source; only generated IR wrappers receive slots.
 */
export function normalizeHtmlParagraph(block: Block, options?: HtmlOptions) {
  const source = block.payload.raw;
  let attribute = "smdxinline";
  const lower = source.toLowerCase();
  while (lower.includes(attribute)) attribute += "x";
  const inline: InlineNode[] = [];
  const serialize = (nodes: InlineNode[]): string => nodes.map((node): string => {
    if (node.kind === "text") return escapeHtml(node.text);
    if (node.kind === "html") {
      if (node.isClose) return node.raw;
      const open = node.openingRaw ?? node.raw;
      if (node.isSelfClosing) return open;
      const literal = ["pre", "code", "textarea", ...(options?.literalTagContent ?? [])]
        .some((tag) => tag.toLowerCase() === node.tagName);
      const children = literal
        ? (node.children ?? []).map((child) => child.kind === "text" ? escapeHtml(child.text) : inlineHtml([child])).join("")
        : serialize(node.children ?? []);
      return open + children + (node.closingRaw ?? "");
    }
    const index = inline.push(node) - 1;
    const slot = ` ${attribute}="${index}"`;
    if (node.kind === "strong" || node.kind === "em" || node.kind === "strike" || node.kind === "link") {
      const tag = node.kind === "strike" ? "del" : node.kind === "link" ? "a" : node.kind;
      const href = node.kind === "link" && node.href !== undefined ? ` href="${escapeHtml(node.href)}"` : "";
      return `<${tag}${slot}${href}>${serialize(node.children)}</${tag}>`;
    }
    if (node.kind === "plugin" && node.children) {
      return `<span${slot}>${serialize(node.children)}</span>`;
    }
    return `<span${slot}>${inlineHtml([node])}</span>`;
  }).join("");
  return sanitizeHtmlTreeInWorker(`<p class="markdown-paragraph" ${attribute}="paragraph">${serialize(block.payload.inline ?? [])}</p>\n`, options, { attribute, inline });
}

/** JSX tags in prose belong to mixed-content segments, never the HTML sanitizer. */
export function preserveInlineComponentSource(nodes: InlineNode[]): InlineNode[] {
  let result = nodes;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    let next = node;
    if (node.kind === "html" && /^<\/?[A-Z]/.test(node.openingRaw ?? node.raw)) {
      next = { kind: "text", text: node.raw };
    } else if ("children" in node && node.children) {
      const children = preserveInlineComponentSource(node.children);
      if (children !== node.children) next = { ...node, children };
    }
    if (next !== node) {
      if (result === nodes) result = nodes.slice();
      result[index] = next;
    }
  }
  return result;
}

export function containsInlineHtml(nodes: InlineNode[]): boolean {
  for (const node of nodes) {
    if (node.kind === "html") return true;
    if ("children" in node && node.children && containsInlineHtml(node.children)) return true;
  }
  return false;
}
