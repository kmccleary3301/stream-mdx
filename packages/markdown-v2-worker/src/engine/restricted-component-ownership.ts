import type { MarkdownParser } from "@lezer/markdown";
import {
  isRestrictedComponentName,
  parseRestrictedTag,
  type Block,
  type HtmlTreeNode,
  type InlineNode,
  type RestrictedComponentDescriptor,
  type RestrictedTagParseResult,
} from "@stream-mdx/core";

type SourceRange = { readonly from: number; readonly to: number };

export type RestrictedComponentTag =
  | {
      readonly kind: "open" | "self-closing";
      readonly name: string;
      readonly from: number;
      readonly to: number;
      readonly props: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "close";
      readonly name: string;
      readonly from: number;
      readonly to: number;
    };

type LocatedRestrictedTag =
  | { readonly kind: "tag"; readonly from: number; readonly to: number; readonly parsed: Extract<RestrictedTagParseResult, { ok: true }> }
  | { readonly kind: "invalid"; readonly name: string; readonly error: string; readonly incomplete: boolean };

function findTagEnd(source: string, start: number): number | null {
  let quote: string | null = null;
  let braceDepth = 0;
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (braceDepth > 0 && character === "\\" && index + 1 < source.length) index++;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "{") braceDepth++;
    else if (character === "}" && braceDepth > 0) braceDepth--;
    else if (character === ">" && braceDepth === 0) return index + 1;
  }
  return null;
}

function locateRestrictedTag(
  source: string,
  start: number,
  contentComponents: ReadonlyMap<string, RestrictedComponentDescriptor>,
): LocatedRestrictedTag | null {
  const closing = /^<\/\s*([A-Za-z][\w-]*)/.exec(source.slice(start));
  const opening = closing ? null : /^<\s*([A-Za-z][\w-]*)/.exec(source.slice(start));
  const match = closing ?? opening;
  const name = match?.[1];
  if (!match || !name || !isRestrictedComponentName(name) || !contentComponents.has(name)) return null;

  const end = findTagEnd(source, start);
  if (end === null) {
    return { kind: "invalid", name, error: `Incomplete component header <${name}>`, incomplete: true };
  }
  const parsed = parseRestrictedTag(source.slice(start, end));
  if (!parsed.ok) {
    return { kind: "invalid", name, error: parsed.error, incomplete: parsed.incomplete === true };
  }
  if (parsed.tagName !== name) {
    return { kind: "invalid", name, error: `Invalid component tag <${name}>`, incomplete: false };
  }
  return { kind: "tag", from: start, to: end, parsed };
}

export interface RestrictedInlineElement {
  readonly type: number;
  readonly from: number;
  readonly to: number;
  readonly children?: readonly RestrictedInlineElement[];
}

const DEFAULT_LITERAL_TAG_CONTENT = new Set(["code", "pre", "textarea", "script", "style"]);

function collectProtectedRanges(
  source: string,
  parser: MarkdownParser,
  elements: readonly RestrictedInlineElement[],
  literalTagContent: readonly string[],
): SourceRange[] {
  const ranges: SourceRange[] = [];
  const literalNames = literalTagContent.length === 0
    ? DEFAULT_LITERAL_TAG_CONTENT
    : new Set([...DEFAULT_LITERAL_TAG_CONTENT, ...literalTagContent.map((name) => name.toLowerCase())]);
  const literalTags: Array<{ from: number; to: number; name: string; isClose: boolean; isSelfClosing: boolean }> = [];

  const visit = (nodes: readonly RestrictedInlineElement[]) => {
    for (const element of nodes) {
      const name = parser.nodeSet.types[element.type]?.name;
      if (name === "InlineCode" || name === "Escape") {
        ranges.push({ from: element.from, to: element.to });
        continue;
      }
      if (name === "HTMLTag") {
        const raw = source.slice(element.from, element.to);
        const tag = /^<\/?\s*([A-Za-z][\w:-]*)/.exec(raw);
        const tagName = tag?.[1]?.toLowerCase();
        if (tagName && literalNames.has(tagName)) {
          literalTags.push({
            from: element.from,
            to: element.to,
            name: tagName,
            isClose: raw.startsWith("</"),
            isSelfClosing: raw.endsWith("/>"),
          });
        }
      }
      if (element.children?.length) visit(element.children);
    }
  };
  visit(elements);

  literalTags.sort((left, right) => left.from - right.from);
  const openLiteralTags: Array<{ name: string; contentFrom: number }> = [];
  for (const tag of literalTags) {
    if (tag.isClose) {
      let index = openLiteralTags.length - 1;
      while (index >= 0 && openLiteralTags[index].name !== tag.name) index--;
      if (index >= 0) {
        ranges.push({ from: openLiteralTags[index].contentFrom, to: tag.from });
        openLiteralTags.length = index;
      }
    } else if (!tag.isSelfClosing) {
      openLiteralTags.push({ name: tag.name, contentFrom: tag.to });
    }
  }
  for (const tag of openLiteralTags) ranges.push({ from: tag.contentFrom, to: source.length });
  return ranges;
}


/** Returns only explicitly registered tags accepted by Core's restricted-tag parser. */
export function scanRegisteredRestrictedTags(
  source: string,
  contentComponents: ReadonlyMap<string, RestrictedComponentDescriptor>,
  parser?: MarkdownParser,
  options?: {
    literalTagContent?: readonly string[];
    protectedRanges?: readonly SourceRange[];
    inlineElements?: readonly RestrictedInlineElement[];
  },
): RestrictedComponentTag[] {
  const inlineElements = options?.inlineElements ?? (parser ? parser.parseInline(source, 0) : undefined);
  const protectedRanges = [
    ...(parser && inlineElements
      ? collectProtectedRanges(source, parser, inlineElements, options?.literalTagContent ?? [])
      : []),
    ...(options?.protectedRanges ?? []),
  ].sort((left, right) => left.from - right.from);
  const tags: RestrictedComponentTag[] = [];
  let rangeIndex = 0;
  for (let index = 0; index < source.length; index++) {
    while (rangeIndex < protectedRanges.length && protectedRanges[rangeIndex].to <= index) rangeIndex++;
    const protectedRange = protectedRanges[rangeIndex];
    if (protectedRange && protectedRange.from <= index && index < protectedRange.to) {
      index = protectedRange.to - 1;
      continue;
    }
    if (source[index] !== "<") continue;
    const located = locateRestrictedTag(source, index, contentComponents);
    if (!located || located.kind === "invalid") continue;
    if (located.parsed.kind === "close") {
      tags.push({ kind: "close", name: located.parsed.tagName, from: located.from, to: located.to });
    } else {
      tags.push({
        kind: located.parsed.kind,
        name: located.parsed.tagName,
        from: located.from,
        to: located.to,
        props: located.parsed.props,
      });
    }
    index = located.to - 1;
  }
  return tags;
}

function textNode(text: string, parseInline?: (text: string) => InlineNode[]): HtmlTreeNode | null {
  if (!text.trim()) return null;
  return { kind: "text", text, inline: parseInline ? parseInline(text) : undefined };
}

function findRootClosingTag(
  name: string,
  opening: RestrictedComponentTag,
  tags: readonly RestrictedComponentTag[],
): RestrictedComponentTag | undefined {
  const stack = [name];
  for (const tag of tags) {
    if (tag.from <= opening.from) continue;
    if (tag.kind === "open") {
      stack.push(tag.name);
    } else if (tag.kind === "close") {
      let index = stack.length - 1;
      while (index >= 0 && stack[index] !== tag.name) index--;
      if (index >= 0) {
        stack.length = index;
        if (stack.length === 0) return tag;
      }
    }
  }
  return undefined;
}

function literalComponentNode(rawSource: string, diagnostic: string): HtmlTreeNode[] {
  return [{ kind: "text", text: rawSource, rawSource, diagnostic }];
}

export function isRegisteredRestrictedComponent(
  name: string,
  contentComponents?: ReadonlyMap<string, RestrictedComponentDescriptor>,
): boolean {
  if (!name || !isRestrictedComponentName(name)) return false;
  return contentComponents ? contentComponents.has(name) : false;
}

/**
 * Builds an HtmlTreeNode array for a single block or multi-block restricted component region.
 *
 * Preserves:
 * - Case-sensitive component names (Input vs input)
 * - Frozen props from parsed opening tags
 * - Native Markdown/code/list block leaves as children
 * - Status: "open" | "closed" | "incomplete"
 * - Incomplete retained at FINALIZE with diagnostic
 * - Unknown or invalid component tags fall back to text nodes with diagnostics
 */
export function buildRestrictedComponentTree(
  rawSource: string,
  contentComponents: ReadonlyMap<string, RestrictedComponentDescriptor>,
  options?: {
    forceFinalize?: boolean;
    parseInline?: (text: string) => InlineNode[];
    childrenBlocks?: Block[];
    childBlockRanges?: readonly { readonly block: Block; readonly from: number; readonly to: number }[];
    sourceOffset?: number;
    parser?: MarkdownParser;
    literalTagContent?: readonly string[];
    containerClosed?: boolean;
  },
): HtmlTreeNode[] | null {
  const firstNonWhitespace = rawSource.search(/\S/);
  if (firstNonWhitespace < 0 || rawSource[firstNonWhitespace] !== "<") return null;

  const nameMatch = /^<\s*([A-Za-z][\w-]*)/.exec(rawSource.slice(firstNonWhitespace));
  if (!nameMatch) return null;
  const componentName = nameMatch[1];
  if (!isRestrictedComponentName(componentName)) return null;
  if (!contentComponents.has(componentName)) {
    return literalComponentNode(rawSource, `Unknown component <${componentName}>`);
  }

  const located = locateRestrictedTag(rawSource, firstNonWhitespace, contentComponents);
  if (!located) return null;
  if (located.kind === "invalid") {
    return literalComponentNode(
      rawSource,
      `Invalid component tag <${componentName}>: ${located.error}`,
    );
  }
  if (located.parsed.kind === "close") {
    return literalComponentNode(rawSource, `Unexpected stray closing tag </${componentName}>`);
  }

  const opening: RestrictedComponentTag = {
    kind: located.parsed.kind,
    name: located.parsed.tagName,
    from: located.from,
    to: located.to,
    props: located.parsed.props,
  };
  const childBlocks = options?.childrenBlocks ?? [];
  const childRanges = childBlocks.map((block, index) => {
    const supplied = options?.childBlockRanges?.[index];
    if (supplied?.block === block) return supplied;
    const range = block.payload.range;
    if (range && options?.sourceOffset !== undefined) {
      return { block, from: range.from - options.sourceOffset, to: range.to - options.sourceOffset };
    }
    return undefined;
  });
  const protectedCodeRanges = childRanges.flatMap((range, index) =>
    range && childBlocks[index].type === "code" ? [{ from: range.from, to: range.to }] : [],
  );
  const tags = scanRegisteredRestrictedTags(rawSource, contentComponents, options?.parser, {
    literalTagContent: options?.literalTagContent,
    protectedRanges: protectedCodeRanges,
  });
  const matchingClose = opening.kind === "open"
    ? findRootClosingTag(componentName, opening, tags)
    : undefined;
  const isSelfClosing = opening.kind === "self-closing";
  const isClosed = isSelfClosing || (options?.containerClosed ?? matchingClose !== undefined);
  const closeStart = !isSelfClosing && isClosed && matchingClose ? matchingClose.from : rawSource.length;
  const rootEnd = !isSelfClosing && isClosed && matchingClose ? matchingClose.to : isSelfClosing ? opening.to : rawSource.length;
  const children: HtmlTreeNode[] = [];

  if (!isSelfClosing && childBlocks.length > 0) {
    const canMapChildren = childRanges.length === childBlocks.length &&
      childRanges.every((range) =>
        range !== undefined &&
        range.from >= 0 &&
        range.to >= range.from &&
        range.to <= rawSource.length,
      );
    if (canMapChildren) {
      let cursor = opening.to;
      for (let index = 0; index < childBlocks.length; index++) {
        const range = childRanges[index];
        if (!range) continue;
        const childFrom = Math.max(cursor, range.from, opening.to);
        const childTo = Math.min(range.to, closeStart);
        const before = textNode(rawSource.slice(cursor, childFrom), options?.parseInline);
        if (before) children.push(before);
        if (childTo > childFrom) children.push({ kind: "block", block: childBlocks[index] });
        cursor = Math.max(cursor, childTo);
      }
      const after = textNode(rawSource.slice(cursor, closeStart), options?.parseInline);
      if (after) children.push(after);
    } else {
      for (const block of childBlocks) children.push({ kind: "block", block });
    }
  } else if (!isSelfClosing) {
    const body = textNode(rawSource.slice(opening.to, closeStart), options?.parseInline);
    if (body) children.push(body);
  }

  const component: HtmlTreeNode = {
    kind: "component",
    name: componentName,
    props: opening.props,
    status: isClosed ? "closed" : options?.forceFinalize ? "incomplete" : "open",
    children,
    rawSource: rawSource.slice(firstNonWhitespace, rootEnd),
    diagnostic: !isClosed && options?.forceFinalize ? `Unclosed component tag <${componentName}>` : undefined,
  };
  const tree: HtmlTreeNode[] = [];
  const prefix = textNode(rawSource.slice(0, firstNonWhitespace), options?.parseInline);
  if (prefix) tree.push(prefix);
  tree.push(component);
  const suffix = textNode(rawSource.slice(rootEnd), options?.parseInline);
  if (suffix) tree.push(suffix);
  return tree;
}
