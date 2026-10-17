import type { MarkdownParser } from "@lezer/markdown";
import { dedentIndentedCode, sanitizeHtmlTreeInWorker, stripCodeFence, type Block, type ContentPolicy, type HtmlOptions, type HtmlTreeNode, type InlineNode, type RestrictedComponentDescriptor } from "@stream-mdx/core";
import { trimProvisionalFenceTail } from "./parse-extract";
import { buildRestrictedComponentTree, isRegisteredRestrictedComponent, scanRegisteredRestrictedTags, type RestrictedInlineElement } from "./restricted-component-ownership";

const VOID: Record<string, true> = { area: true, base: true, br: true, col: true, embed: true, hr: true, img: true, input: true, link: true, meta: true, param: true, source: true, track: true, wbr: true };
const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function inlineHtml(nodes: InlineNode[]): string {
  return nodes.map((node): string => {
    switch (node.kind) {
      case "text": return escapeHtml(node.text);
      // Ownership markup is inert; the marked native slot retains its MDX projection.
      case "trusted-mdx-inline": return escapeHtml(node.raw);
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
 * Apply one raw fragment's Lezer HTMLTag open/close effects to an open-container stack.
 *
 * MDX component names are case-sensitive: `<Input>` and `<Link>` are components, while `<input>` and
 * `<link>` are the HTML void elements. `mdxComponents` is the caller's MDX mode; without it, names
 * take their HTML identity case-insensitively, matching CommonMark's tag handling.
 */
export function applyHtmlTagBalance(
  raw: string,
  parser: MarkdownParser,
  stack: string[],
  mdxComponents = false,
  contentComponents?: ReadonlyMap<string, RestrictedComponentDescriptor>,
  literalTagContent?: readonly string[],
): void {
  type BalanceTag = {
    readonly from: number;
    readonly to: number;
    readonly name: string;
    readonly isClose: boolean;
    readonly isSelfClosing: boolean;
    readonly component: boolean;
  };
  const tags: BalanceTag[] = [];
  const elements: readonly RestrictedInlineElement[] = parser.parseInline(raw, 0);
  const visit = (nodes: readonly RestrictedInlineElement[]) => {
    for (const element of nodes) {
      const nodeName = parser.nodeSet.types[element.type]?.name;
      if (nodeName === "InlineCode" || nodeName === "Escape") continue;
      if (nodeName === "HTMLTag") {
        const tag = raw.slice(element.from, element.to);
        const written = /^<\/?([a-zA-Z][^\s/>]*)/.exec(tag)?.[1];
        if (written) {
          const isUppercase = /^[A-Z]/.test(written);
          const isRegistered = Boolean(contentComponents && isRegisteredRestrictedComponent(written, contentComponents));
          if (!isRegistered && !(contentComponents && isUppercase && !mdxComponents)) {
            const component = isUppercase && mdxComponents;
            tags.push({
              from: element.from,
              to: element.to,
              name: component ? written : written.toLowerCase(),
              isClose: tag.startsWith("</"),
              isSelfClosing: tag.endsWith("/>"),
              component,
            });
          }
        }
      }
      if (element.children?.length) visit(element.children);
    }
  };
  visit(elements);

  if (contentComponents) {
    const registeredTags = scanRegisteredRestrictedTags(raw, contentComponents, parser, {
      literalTagContent,
      inlineElements: elements,
    });
    for (const tag of registeredTags) {
      tags.push({
        from: tag.from,
        to: tag.to,
        name: tag.name,
        isClose: tag.kind === "close",
        isSelfClosing: tag.kind === "self-closing",
        component: true,
      });
    }
  }

  tags.sort((left, right) => left.from - right.from);
  for (const tag of tags) {
    if (tag.isClose) {
      const at = stack.lastIndexOf(tag.name);
      if (at >= 0) stack.length = at;
    } else if ((tag.component || !VOID[tag.name]) && !tag.isSelfClosing) {
      stack.push(tag.name);
    }
  }
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

function applyRestrictedComponentTagBalance(
  raw: string,
  parser: MarkdownParser,
  stack: string[],
  contentComponents: ReadonlyMap<string, RestrictedComponentDescriptor>,
  literalTagContent?: readonly string[],
): void {
  for (const tag of scanRegisteredRestrictedTags(raw, contentComponents, parser, { literalTagContent })) {
    if (tag.kind === "close") {
      const at = stack.lastIndexOf(tag.name);
      if (at >= 0) stack.length = at;
    } else if (tag.kind === "open") {
      stack.push(tag.name);
    }
  }
}

/** Own balanced HTML regions across native block boundaries, retaining pending MDX roots. */
export function groupHtmlOwnership(blocks: Block[], parser: MarkdownParser, content: string, options?: HtmlOptions, sourceOffset = 0, parseInline?: (text: string) => InlineNode[], regionOptions?: { joinLeafRaws?: boolean; forceFinalize?: boolean; mdxComponents?: boolean; contentPolicy?: ContentPolicy; contentComponents?: ReadonlyMap<string, RestrictedComponentDescriptor> }): Block[] {
  const contentComponents = regionOptions?.contentPolicy === "markdown" || regionOptions?.contentPolicy === "trusted-mdx"
    ? undefined
    : regionOptions?.contentComponents;
  const result: Block[] = [];
  let region: Block[] = [];
  let stack: string[] = [];
  let pendingComponent = false;
  const buildComponentTree = (
    rawSource: string,
    containerClosed: boolean,
    childrenBlocks?: Block[],
    childBlockRanges?: readonly { readonly block: Block; readonly from: number; readonly to: number }[],
    componentSourceOffset?: number,
  ) => contentComponents
    ? buildRestrictedComponentTree(rawSource, contentComponents, {
        forceFinalize: regionOptions?.forceFinalize,
        parseInline,
        childrenBlocks,
        childBlockRanges,
        sourceOffset: componentSourceOffset,
        parser,
        literalTagContent: options?.literalTagContent,
        containerClosed,
      })
    : null;
  const retainComponentTree = (block: Block, htmlTree: HtmlTreeNode[]): Block => ({
    ...block,
    isFinalized: htmlTree[0]?.kind === "component" ? htmlTree[0].status !== "open" : block.isFinalized,
    payload: {
      ...block.payload,
      meta: { ...block.payload.meta, htmlTree, htmlOwnership: true },
    },
  });
  const flush = () => {
    if (stack.length > 0 && !pendingComponent) {
      // An unclosed HTML tag is not evidence that later native paragraphs or lists belong to it.
      // Keep their original blocks and ranges; only an authored close can extend HTML ownership.
      for (const block of region) result.push(block);
    } else if (region.length === 1) {
      const single = region[0];
      const compTree = buildComponentTree(single.payload.raw, stack.length === 0);
      result.push(compTree ? retainComponentTree(single, compTree) : single);
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
      const rawParts = regionOptions?.joinLeafRaws
        ? region.map((block) => (block.type === "code" ? codeCompileSource(block) : (block.payload.raw ?? "").replace(/\n$/, "")))
        : undefined;
      const raw = rawParts
        ? rawParts.join("\n\n")
        : content.slice((first.payload.range?.from ?? sourceOffset) - sourceOffset, (last.payload.range?.to ?? content.length + sourceOffset) - sourceOffset);
      const childrenBlocks = stack.length === 0 ? region.slice(1, region.length - 1) : region.slice(1);
      const firstSourceOffset = first.payload.range?.from ?? sourceOffset;
      let childBlockRanges: { block: Block; from: number; to: number }[] | undefined;
      if (rawParts) {
        const rawPartOffsets: number[] = [];
        let rawOffset = 0;
        for (const part of rawParts) {
          rawPartOffsets.push(rawOffset);
          rawOffset += part.length + 2;
        }
        childBlockRanges = childrenBlocks.map((block) => {
          const index = region.indexOf(block);
          const from = rawPartOffsets[index];
          return { block, from, to: from + rawParts[index].length };
        });
      } else {
        const ranges = childrenBlocks.map((block) => {
          const range = block.payload.range;
          return range
            ? { block, from: range.from - firstSourceOffset, to: range.to - firstSourceOffset }
            : undefined;
        });
        if (ranges.every((range): range is { block: Block; from: number; to: number } => range !== undefined)) {
          childBlockRanges = ranges;
        }
      }
      const compTree = buildComponentTree(
        raw,
        stack.length === 0,
        childrenBlocks,
        childBlockRanges,
        rawParts ? undefined : firstSourceOffset,
      );
      if (compTree) {
        const retained = retainComponentTree(first, compTree);
        result.push({
          ...retained,
          isFinalized: compTree[0]?.kind === "component"
            ? compTree[0].status !== "open"
            : (stack.length === 0 || regionOptions?.forceFinalize === true) && last.isFinalized,
          payload: {
            ...retained.payload,
            raw,
            range: { from: first.payload.range?.from ?? sourceOffset, to: last.payload.range?.to ?? content.length + sourceOffset },
          },
        });
      } else {
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
    }
    region = [];
    stack = [];
    pendingComponent = false;
  };
  for (const block of blocks) {
    if (block.type !== "code") {
      if (region.length > 0 || block.type === "html") {
        applyHtmlTagBalance(
          block.payload.raw,
          parser,
          stack,
          regionOptions?.mdxComponents === true,
          contentComponents,
          options?.literalTagContent,
        );
      } else if (contentComponents) {
        applyRestrictedComponentTagBalance(
          block.payload.raw,
          parser,
          stack,
          contentComponents,
          options?.literalTagContent,
        );
      }
    }
    if (region.length === 0 && stack.length === 0) {
      const compTree = buildComponentTree(block.payload.raw, true);
      result.push(compTree ? retainComponentTree(block, compTree) : block);
      continue;
    }
    if (region.length === 0) {
      const top = stack[0] ?? "";
      const isComp = Boolean(
        (contentComponents && isRegisteredRestrictedComponent(top, contentComponents)) ||
        (regionOptions?.mdxComponents === true && /^[A-Z]/.test(top)),
      );
      pendingComponent = isComp;
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
