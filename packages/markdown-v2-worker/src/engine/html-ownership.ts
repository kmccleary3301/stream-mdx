import type { MarkdownParser } from "@lezer/markdown";
import { dedentIndentedCode, removeHeadingMarkers, sanitizeHtmlInWorker, sanitizeHtmlTreeInWorker, stripCodeFence, type Block, type ContainerExtensionSpec, type ContentPolicy, type HtmlOptions, type HtmlTreeNode, type InlineNode, type RestrictedComponentDescriptor, type SourceSnapshot } from "@stream-mdx/core";
import { trimProvisionalFenceTail } from "./parse-extract";
import { buildRegisteredContainerTree, buildRestrictedComponentInlineTree, buildRestrictedComponentTree, buildRestrictedHtmlComponentTree, isRegisteredRestrictedComponent, scanRegisteredContainerSource, scanRegisteredRestrictedTags, type RestrictedInlineElement } from "./restricted-component-ownership";
import type { RegisteredContainerOpening } from "./registered-component-owner";
import { escapeHtml, inlineHtml, normalizeNativeInlineParagraph } from "./native-inline-normalization";

const VOID: Record<string, true> = { area: true, base: true, br: true, col: true, embed: true, hr: true, img: true, input: true, link: true, meta: true, param: true, source: true, track: true, wbr: true };

function hasSourceLineTerminatorAfterBlock(
  block: Block,
  content: string | SourceSnapshot,
  sourceOffset: number,
): boolean {
  const rangeTo = block.payload.range?.to;
  if (typeof rangeTo !== "number") return false;
  const localEnd = rangeTo - sourceOffset;
  if (localEnd < 0 || localEnd >= content.length) return false;
  const unit = typeof content === "string"
    ? content[localEnd]
    : content.read(localEnd, localEnd + 1);
  if (unit === "\n") return true;
  if (unit !== "\r" || localEnd + 1 >= content.length) return false;
  return typeof content === "string"
    ? content[localEnd + 1] === "\n"
    : content.read(localEnd + 1, localEnd + 2) === "\n";
}

function isCompleteHtmlTag(tag: string): boolean {
  if (!tag.endsWith(">")) return false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < tag.length; index += 1) {
    const char = tag[index];
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    }
  }
  return quote === null;
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
        if (isCompleteHtmlTag(tag)) {
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

/**
 * Open type-6/7 HTML blocks own physical source through the next blank line,
 * even when an incremental Lezer fragment retained only an earlier line.
 */
/**
 * Component boundaries own these HTML blocks: the registered header boundary ends a restricted
 * opening at its header line, and trusted MDX flow roots end at their compiler-authored close.
 */
function opensComponent(
  block: Block,
  contentComponents: ReadonlyMap<string, RestrictedComponentDescriptor> | undefined,
  mdxComponents: boolean,
): boolean {
  if (block.type !== "html" || (!contentComponents && !mdxComponents)) return false;
  const name = /^[ \t]*<\s*([A-Za-z][\w-]*)/.exec(block.payload.raw ?? "")?.[1];
  if (name === undefined) return false;
  return (mdxComponents && /^[A-Z]/.test(name)) || contentComponents?.has(name) === true;
}

function recoverHtmlPhysicalSourceRange(
  block: Block,
  content: string | SourceSnapshot,
  sourceOffset: number,
  options?: HtmlOptions,
  parseInline?: (text: string) => InlineNode[],
): Block {
  const range = block.payload.range;
  const meta = block.payload.meta;
  if (block.type !== "html" || meta?.lezerNodeType !== "HTMLBlock" || !range) return block;
  const rawSource = block.payload.raw ?? "";
  if (
    !/^[ \t]*<\/?[A-Za-z][\w-]*(?=[ \t/>]|$)/.test(rawSource) ||
    /^[ \t]*<(?:script|pre|style|textarea)(?:\s|>|$)/i.test(rawSource)
  ) {
    return block;
  }

  const localFrom = range.from - sourceOffset;
  const sourceLength = content.length;
  if (localFrom < 0 || localFrom >= sourceLength) return block;

  let lineStart = localFrom;
  let lastLineEnd = localFrom;
  let firstLine = true;
  while (lineStart <= sourceLength) {
    let lineEnd = sourceLength;
    let lineBreakCode = 0;
    let blank = true;
    if (typeof content === "string") {
      for (let index = lineStart; index < sourceLength; index++) {
        const code = content.charCodeAt(index);
        if (code === 10 || code === 13) {
          lineEnd = index;
          lineBreakCode = code;
          break;
        }
        if (code !== 9 && code !== 32) blank = false;
      }
    } else {
      let cursor = lineStart;
      while (cursor < sourceLength) {
        const chunkEnd = Math.min(cursor + 1024, sourceLength);
        const chunk = content.read(cursor, chunkEnd);
        let foundLineBreak = false;
        for (let index = 0; index < chunk.length; index++) {
          const code = chunk.charCodeAt(index);
          if (code === 10 || code === 13) {
            lineEnd = cursor + index;
            lineBreakCode = code;
            foundLineBreak = true;
            break;
          }
          if (code !== 9 && code !== 32) blank = false;
        }
        if (foundLineBreak) break;
        cursor = chunkEnd;
      }
    }
    if (blank) {
      if (firstLine) return block;
      break;
    }

    lastLineEnd = lineEnd;
    firstLine = false;
    if (lineEnd === sourceLength) break;
    lineStart = lineEnd + 1;
    if (lineBreakCode === 13 && lineStart < sourceLength) {
      const nextCode = typeof content === "string"
        ? content.charCodeAt(lineStart)
        : content.read(lineStart, lineStart + 1).charCodeAt(0);
      if (nextCode === 10) lineStart++;
    }
  }

  const sourceTo = sourceOffset + lastLineEnd;
  if (sourceTo <= range.to) return block;
  const raw = typeof content === "string" ? content.slice(localFrom, lastLineEnd) : content.read(localFrom, lastLineEnd);
  const existingProtected = Array.isArray(meta.protectedRanges) ? meta.protectedRanges as unknown[] : [];
  const protectedRanges = existingProtected.filter((candidate) => {
    if (!candidate || typeof candidate !== "object" || !("kind" in candidate)) return true;
    return candidate.kind !== "html-block";
  });
  protectedRanges.push({ from: 0, to: raw.length, kind: "html-block" });
  return {
    ...block,
    payload: {
      ...block.payload,
      raw,
      sanitizedHtml: sanitizeHtmlInWorker(raw, options),
      range: { ...range, to: sourceTo },
      meta: {
        ...meta,
        sanitized: true,
        htmlTree: sanitizeHtmlTreeInWorker(raw, options, undefined, parseInline),
        protectedRanges,
      },
    },
  };
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

export function getActiveHtmlTreeKey(
  meta: Record<string, unknown> | undefined,
): "htmlTree" | "htmlParagraphTree" | undefined {
  if (meta?.htmlOwnership === true && Array.isArray(meta.htmlTree)) return "htmlTree";
  if (Array.isArray(meta?.htmlParagraphTree)) return "htmlParagraphTree";
  if (Array.isArray(meta?.htmlTree)) return "htmlTree";
}
export function finalizeOpenRegisteredContainerTree(nodes: readonly HtmlTreeNode[]): readonly HtmlTreeNode[] {
  let next: HtmlTreeNode[] | undefined;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    let replacement = node;
    if (node.kind === "component" || node.kind === "element") {
      const children = finalizeOpenRegisteredContainerTree(node.children);
      if (node.kind === "component") {
        const containerName = /^:{3,}([A-Za-z][\w-]*)/.exec(node.rawSource?.trimStart() ?? "")?.[1];
        replacement = node.status === "open" && containerName
          ? { ...node, status: "incomplete", diagnostic: `Unclosed container :::${containerName}`, children: [...children] }
          : children === node.children ? node : { ...node, children: [...children] };
      } else {
        replacement = children === node.children ? node : { ...node, children: [...children] };
      }
    } else if (node.kind === "block") {
      const meta = node.block.payload.meta;
      const key = getActiveHtmlTreeKey(meta);
      const tree = key ? meta?.[key] : undefined;
      if (key && Array.isArray(tree)) {
        const children = finalizeOpenRegisteredContainerTree(tree as HtmlTreeNode[]);
        if (children !== tree) {
          replacement = {
            ...node,
            block: { ...node.block, payload: { ...node.block.payload, meta: { ...meta, [key]: children } } },
          };
        }
      }
    }
    if (replacement !== node) {
      next ??= nodes.slice(0, index);
      next.push(replacement);
    } else {
      next?.push(node);
    }
  }
  return next ?? nodes;
}


function withHtmlOwnership(
  meta: Block["payload"]["meta"],
  htmlTree: HtmlTreeNode[],
): NonNullable<Block["payload"]["meta"]> {
  const nextMeta = { ...meta, htmlTree, htmlOwnership: true };
  delete nextMeta.htmlParagraphTree;
  return nextMeta;
}

/** Own balanced HTML regions across native block boundaries, retaining pending MDX roots. */
export function groupHtmlOwnership(blocks: Block[], parser: MarkdownParser, content: string | SourceSnapshot, options?: HtmlOptions, sourceOffset = 0, parseInline?: (text: string) => InlineNode[], regionOptions?: { joinLeafRaws?: boolean; forceFinalize?: boolean; mdxComponents?: boolean; contentPolicy?: ContentPolicy; contentComponents?: ReadonlyMap<string, RestrictedComponentDescriptor>; syntaxContainers?: readonly ContainerExtensionSpec[] }): Block[] {
  const contentComponents = regionOptions?.contentPolicy === "markdown" || regionOptions?.contentPolicy === "trusted-mdx"
    ? undefined
    : regionOptions?.contentComponents;
  const syntaxContainers = contentComponents ? regionOptions?.syntaxContainers ?? [] : [];
  const result: Block[] = [];
  let region: Block[] = [];
  let stack: string[] = [];
  let containerStack: RegisteredContainerOpening[] = [];
  let pendingComponent = false;
  const buildComponentTree = (
    rawSource: string,
    containerClosed: boolean,
    childrenBlocks?: Block[],
    childBlockRanges?: readonly { readonly block: Block; readonly from: number; readonly to: number }[],
    componentSourceOffset?: number,
    trailingLineTerminator = false,
  ) => {
    if (!contentComponents) return null;
    const containerTree = syntaxContainers.length > 0
      ? buildRegisteredContainerTree(rawSource, contentComponents, syntaxContainers, {
          forceFinalize: regionOptions?.forceFinalize,
          parseInline,
          childrenBlocks,
          childBlockRanges,
          sourceOffset: componentSourceOffset,
          parser,
          literalTagContent: options?.literalTagContent,
          trailingLineTerminator,
          htmlOptions: options,
        })
      : null;
    return containerTree ?? buildRestrictedComponentTree(rawSource, contentComponents, {
      forceFinalize: regionOptions?.forceFinalize,
      parseInline,
      childrenBlocks,
      childBlockRanges,
      sourceOffset: componentSourceOffset,
      parser,
      literalTagContent: options?.literalTagContent,
      trailingLineTerminator,
      htmlOptions: options,
      containerClosed,
    });
  };
  const retainComponentTree = (block: Block, htmlTree: HtmlTreeNode[]): Block => ({
    ...block,
    isFinalized: htmlTree[0]?.kind === "component" ? htmlTree[0].status !== "open" : block.isFinalized,
    payload: {
      ...block.payload,
      meta: withHtmlOwnership(block.payload.meta, htmlTree),
    },
  });
  const admitNestedBlock = (block: Block): Block => {
    if (!contentComponents || block.type === "code" || block.payload.meta?.htmlOwnership === true) return block;
    const admissionOptions = {
      forceFinalize: regionOptions?.forceFinalize,
      parseInline,
      parser,
      literalTagContent: options?.literalTagContent,
      htmlOptions: options,
      trailingLineTerminator: hasSourceLineTerminatorAfterBlock(block, content, sourceOffset),
    };
    const headingText = block.payload.meta?.headingText;
    const inlineSource = block.type === "heading"
      ? typeof headingText === "string" ? headingText : removeHeadingMarkers(block.payload.raw)
      : block.payload.raw;
    let htmlTree = block.type === "html"
      ? buildRestrictedHtmlComponentTree(block.payload.raw, contentComponents, { ...admissionOptions, htmlOptions: options })
      : block.type === "heading" ? null
        : (syntaxContainers.length > 0
          ? buildRegisteredContainerTree(block.payload.raw, contentComponents, syntaxContainers, admissionOptions)
          : null) ?? buildRestrictedComponentTree(block.payload.raw, contentComponents, admissionOptions);
    if (!htmlTree && (block.type === "paragraph" || block.type === "heading")) {
      const inlineTree = buildRestrictedComponentInlineTree(inlineSource, contentComponents, admissionOptions);
      if (inlineTree) {
        const headingLevel = block.payload.meta?.headingLevel;
        htmlTree = [{
          kind: "element",
          tagName: block.type === "heading" ? `h${typeof headingLevel === "number" ? headingLevel : 1}` : "p",
          attributes: {},
          children: inlineTree,
          ...(block.type === "paragraph" ? { paragraphRoot: true } : {}),
        }];
      }
    }
    if (!htmlTree) return block;
    return {
      ...block,
      payload: {
        ...block.payload,
        meta: withHtmlOwnership(block.payload.meta, htmlTree),
      },
    };
  };
  const flush = () => {
    if ((stack.length > 0 || containerStack.length > 0) && !pendingComponent) {
      // An unclosed HTML tag is not evidence that later native paragraphs or lists belong to it.
      // Keep their original blocks and ranges; only an authored close can extend HTML ownership.
      for (const block of region) result.push(block);
    } else if (region.length === 1) {
      const single = region[0];
      const compTree = buildComponentTree(
        single.payload.raw,
        stack.length === 0,
        undefined,
        undefined,
        undefined,
        hasSourceLineTerminatorAfterBlock(single, content, sourceOffset),
      );
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
        : typeof content === "string"
          ? content.slice((first.payload.range?.from ?? sourceOffset) - sourceOffset, (last.payload.range?.to ?? content.length + sourceOffset) - sourceOffset)
          : content.read((first.payload.range?.from ?? sourceOffset) - sourceOffset, (last.payload.range?.to ?? content.length + sourceOffset) - sourceOffset);
      const childrenBlocks = stack.length === 0 && containerStack.length === 0 ? region.slice(1, region.length - 1) : region.slice(1);
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
        !rawParts && hasSourceLineTerminatorAfterBlock(last, content, sourceOffset),
      );
      if (compTree) {
        const retained = retainComponentTree(first, compTree);
        result.push({
          ...retained,
          isFinalized: compTree[0]?.kind === "component"
            ? compTree[0].status !== "open"
            : (stack.length === 0 && containerStack.length === 0 || regionOptions?.forceFinalize === true) && last.isFinalized,
          payload: {
            ...retained.payload,
            raw,
            range: { from: first.payload.range?.from ?? sourceOffset, to: last.payload.range?.to ?? content.length + sourceOffset },
          },
        });
      } else {
        result.push({
          ...first,
          isFinalized: (stack.length === 0 && containerStack.length === 0 || regionOptions?.forceFinalize === true) && last.isFinalized,
          payload: {
            ...first.payload,
            raw,
            range: { from: first.payload.range?.from ?? sourceOffset, to: last.payload.range?.to ?? content.length + sourceOffset },
            meta: withHtmlOwnership(first.payload.meta, sanitizeHtmlTreeInWorker(html, options, { attribute, blocks: markdown }, parseInline)),
          },
        });
      }
    }
    region = [];
    stack = [];
    containerStack = [];
    pendingComponent = false;
  };
  for (const inputBlock of blocks) {
    let block = regionOptions?.joinLeafRaws || opensComponent(inputBlock, contentComponents, regionOptions?.mdxComponents === true)
      ? inputBlock
      : recoverHtmlPhysicalSourceRange(inputBlock, content, sourceOffset, options, parseInline);
    if (block.type !== "code" && contentComponents && syntaxContainers.length > 0) {
      scanRegisteredContainerSource(block.payload.raw, syntaxContainers, contentComponents, parser, {
        openStack: containerStack,
        trailingLineTerminator: hasSourceLineTerminatorAfterBlock(block, content, sourceOffset),
        literalTagContent: options?.literalTagContent,
      });
    }
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
    if (region.length === 0 && stack.length === 0 && containerStack.length === 0) {
      const compTree = buildComponentTree(block.payload.raw, true);
      result.push(compTree ? retainComponentTree(block, compTree) : admitNestedBlock(block));
      continue;
    }
    if (region.length === 0) {
      const top = stack[0] ?? "";
      const isComp = Boolean(
        (contentComponents && isRegisteredRestrictedComponent(top, contentComponents)) ||
        (regionOptions?.mdxComponents === true && /^[A-Z]/.test(top)),
      );
      pendingComponent = containerStack.length > 0 || isComp;
    }
    if (region.length > 0 || !pendingComponent) block = admitNestedBlock(block);
    region.push(block);
    if (stack.length === 0 && containerStack.length === 0) flush();
  }
  flush();
  return result;
}


/**
 * Browser reconstruction owns the entire paragraph, not independently auto-closed tag fragments.
 * The private attribute cannot occur in user source; only generated IR wrappers receive slots.
 */
export function normalizeHtmlParagraph(block: Block, options?: HtmlOptions) {
  return normalizeNativeInlineParagraph(block.payload.raw, block.payload.inline ?? [], options);
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
