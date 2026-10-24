import type { MarkdownParser } from "@lezer/markdown";
import {
  isRestrictedComponentName,
  parseRestrictedTag,
  sanitizeHtmlTreeInWorker,
  type Block,
  type ContainerExtensionSpec,
  type HtmlOptions,
  type HtmlTreeNode,
  type InlineNode,
  type RestrictedComponentDescriptor,
  type RestrictedTagParseResult,
} from "@stream-mdx/core";
import { normalizeNativeInlineParagraph } from "./native-inline-normalization";
import {
  matchRegisteredContainerCloser,
  matchRegisteredContainerOpening,
  type RegisteredContainerOpening,
} from "./registered-component-owner";

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
  | { readonly kind: "invalid"; readonly from: number; readonly to: number; readonly name: string; readonly error: string; readonly incomplete: boolean };

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
): LocatedRestrictedTag | null {
  const closing = /^<\/\s*([A-Za-z][\w-]*)/.exec(source.slice(start));
  const opening = closing ? null : /^<\s*([A-Za-z][\w-]*)/.exec(source.slice(start));
  const match = closing ?? opening;
  const name = match?.[1];
  if (!match || !name || !isRestrictedComponentName(name)) return null;

  const end = findTagEnd(source, start);
  if (end === null) {
    return { kind: "invalid", from: start, to: source.length, name, error: `Incomplete component header <${name}>`, incomplete: true };
  }
  const parsed = parseRestrictedTag(source.slice(start, end));
  if (!parsed.ok) {
    return { kind: "invalid", from: start, to: end, name, error: parsed.error, incomplete: parsed.incomplete === true };
  }
  if (parsed.tagName !== name) {
    return { kind: "invalid", from: start, to: end, name, error: `Invalid component tag <${name}>`, incomplete: false };
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

function mergeProtectedRanges(ranges: readonly SourceRange[]): SourceRange[] {
  const sorted = ranges
    .filter((range) => range.from < range.to)
    .slice()
    .sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: SourceRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to) {
      merged[merged.length - 1] = { from: previous.from, to: Math.max(previous.to, range.to) };
    } else {
      merged.push({ from: range.from, to: range.to });
    }
  }
  return merged;
}

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
      if (name === "URL" || name === "LinkTitle" || name === "LinkLabel" || name === "LinkReference") {
        ranges.push({ from: element.from, to: element.to });
        continue;
      }
      if (name === "Image" || name === "Autolink" || name === "Comment" || name === "CommentBlock") {
        ranges.push({ from: element.from, to: element.to });
        continue;
      }
      if (name === "HTMLTag") {
        const raw = source.slice(element.from, element.to);
        const tag = /^<\/?\s*([A-Za-z][\w:-]*)/.exec(raw);
        const tagName = tag?.[1]?.toLowerCase();
        const componentHeader = locateRestrictedTag(source, element.from) !== null;
        if (!componentHeader) ranges.push({ from: element.from, to: element.to });
        if (tagName && literalNames.has(tagName) && !componentHeader) {
          literalTags.push({
            from: element.from,
            to: element.to,
            name: tagName,
            isClose: /^<\s*\//.test(raw),
            isSelfClosing: /\/\s*>$/.test(raw),
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
  return mergeProtectedRanges(ranges);
}


export type RestrictedComponentSourceToken =
  | { readonly kind: "tag"; readonly tag: RestrictedComponentTag }
  | { readonly kind: "literal"; readonly from: number; readonly to: number; readonly name: string; readonly raw: string; readonly diagnostic: string };

/** Uses Core's restricted-tag parser while retaining invalid and unknown JSX-like tags as literals. */
export function scanRestrictedComponentSource(
  source: string,
  contentComponents: ReadonlyMap<string, RestrictedComponentDescriptor>,
  parser?: MarkdownParser,
  options?: {
    literalTagContent?: readonly string[];
    protectedRanges?: readonly SourceRange[];
    inlineElements?: readonly RestrictedInlineElement[];
  },
): RestrictedComponentSourceToken[] {
  const inlineElements = options?.inlineElements ?? (parser ? parser.parseInline(source, 0) : undefined);
  const protectedRanges = mergeProtectedRanges([
    ...(parser && inlineElements
      ? collectProtectedRanges(source, parser, inlineElements, options?.literalTagContent ?? [])
      : []),
    ...(options?.protectedRanges ?? []),
  ]);
  const tokens: RestrictedComponentSourceToken[] = [];
  let rangeIndex = 0;
  for (let index = 0; index < source.length; index++) {
    while (rangeIndex < protectedRanges.length && protectedRanges[rangeIndex].to <= index) rangeIndex++;
    const protectedRange = protectedRanges[rangeIndex];
    if (protectedRange && protectedRange.from <= index && index < protectedRange.to) {
      index = protectedRange.to - 1;
      continue;
    }
    if (source[index] !== "<") continue;
    const located = locateRestrictedTag(source, index);
    if (!located) continue;
    if (located.kind === "invalid") {
      tokens.push({
        kind: "literal",
        from: located.from,
        to: located.to,
        name: located.name,
        raw: source.slice(located.from, located.to),
        diagnostic: `Invalid component tag <${located.name}>: ${located.error}`,
      });
    } else if (!contentComponents.has(located.parsed.tagName)) {
      tokens.push({
        kind: "literal",
        from: located.from,
        to: located.to,
        name: located.parsed.tagName,
        raw: source.slice(located.from, located.to),
        diagnostic: `Unknown component <${located.parsed.tagName}>`,
      });
    } else if (located.parsed.kind === "close") {
      tokens.push({
        kind: "tag",
        tag: { kind: "close", name: located.parsed.tagName, from: located.from, to: located.to },
      });
    } else {
      tokens.push({
        kind: "tag",
        tag: {
          kind: located.parsed.kind,
          name: located.parsed.tagName,
          from: located.from,
          to: located.to,
          props: located.parsed.props,
        },
      });
    }
    index = located.to - 1;
  }
  return tokens;
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
  return scanRestrictedComponentSource(source, contentComponents, parser, options)
    .flatMap((token) => token.kind === "tag" ? [token.tag] : []);
}
function textNode(text: string, parseInline?: (text: string) => InlineNode[]): HtmlTreeNode | null {
  if (!text.trim()) return null;
  return { kind: "text", text, inline: parseInline ? parseInline(text) : undefined };
}

type RestrictedRootMatch =
  | { readonly kind: "closed"; readonly closing: RestrictedComponentTag }
  | { readonly kind: "mismatched"; readonly closing: RestrictedComponentTag; readonly expected: string }
  | { readonly kind: "unclosed" };

function findRootClosingTag(
  name: string,
  opening: RestrictedComponentTag,
  tags: readonly RestrictedComponentTag[],
  rangeEnd = Number.POSITIVE_INFINITY,
): RestrictedRootMatch {
  const stack = [name];
  for (const tag of tags) {
    if (tag.from <= opening.from) continue;
    if (tag.from >= rangeEnd) break;
    if (tag.kind === "open") {
      stack.push(tag.name);
    } else if (tag.kind === "close") {
      const expected = stack[stack.length - 1];
      if (tag.name !== expected) return { kind: "mismatched", closing: tag, expected };
      stack.pop();
      if (stack.length === 0) return { kind: "closed", closing: tag };
    }
  }
  return { kind: "unclosed" };
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

type RestrictedAdmissionOptions = {
  forceFinalize?: boolean;
  parseInline?: (text: string) => InlineNode[];
  parser?: MarkdownParser;
  literalTagContent?: readonly string[];
  protectedRanges?: readonly SourceRange[];
  htmlOptions?: HtmlOptions;
  trailingLineTerminator?: boolean;
};

export type RegisteredContainerDelimiterEvent =
  | { readonly kind: "open"; readonly from: number; readonly to: number; readonly opening: RegisteredContainerOpening }
  | { readonly kind: "close"; readonly from: number; readonly to: number; readonly opening: RegisteredContainerOpening };

export function scanRegisteredContainerSource(
  source: string,
  extensions: readonly ContainerExtensionSpec[],
  contentComponents: ReadonlyMap<string, RestrictedComponentDescriptor>,
  parser?: MarkdownParser,
  options?: {
    readonly protectedRanges?: readonly SourceRange[];
    readonly blockStartOffsets?: readonly number[];
    readonly literalTagContent?: readonly string[];
    readonly openStack?: RegisteredContainerOpening[];
    readonly trailingLineTerminator?: boolean;
  },
): RegisteredContainerDelimiterEvent[] {
  const inlineElements = parser?.parseInline(source, 0);
  const protectedRanges = mergeProtectedRanges([
    ...(parser && inlineElements
      ? collectProtectedRanges(source, parser, inlineElements, options?.literalTagContent ?? [])
      : []),
    ...(options?.protectedRanges ?? []),
  ]);
  const blockStarts = new Set(options?.blockStartOffsets ?? []);
  const openStack = options?.openStack ?? [];
  const events: RegisteredContainerDelimiterEvent[] = [];
  let rangeIndex = 0;
  let lineStart = 0;
  let previousLineBlank = false;
  let previousWasFence = false;

  while (lineStart <= source.length) {
    const newline = source.indexOf("\n", lineStart);
    const hasLineTerminator = newline >= 0 || (newline < 0 && options?.trailingLineTerminator === true);
    const lineEnd = newline >= 0 ? newline : source.length;
    const contentEnd = lineEnd > lineStart && source[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    const line = source.slice(lineStart, contentEnd);
    const protectedTo = newline >= 0 ? newline + 1 : lineEnd;
    while (rangeIndex < protectedRanges.length && protectedRanges[rangeIndex]!.to <= lineStart) rangeIndex++;
    const protectedRange = protectedRanges[rangeIndex];
    const isProtected = protectedRange !== undefined && protectedRange.from < protectedTo && protectedRange.to > lineStart;

    let wasFence = false;
    if (!isProtected) {
      const opening = matchRegisteredContainerOpening(
        line,
        extensions,
        contentComponents,
        lineStart === 0 || blockStarts.has(lineStart) || previousLineBlank || previousWasFence,
        hasLineTerminator,
      );
      if (opening) {
        openStack.push(opening);
        events.push({ kind: "open", from: lineStart, to: contentEnd, opening });
        wasFence = true;
      } else {
        const top = openStack[openStack.length - 1];
        if (top && matchRegisteredContainerCloser(line, top.fenceLength)) {
          openStack.pop();
          events.push({ kind: "close", from: lineStart, to: contentEnd, opening: top });
          wasFence = true;
        }
      }
    }

    previousLineBlank = line.trim().length === 0;
    previousWasFence = wasFence;
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  return events;
}


type RestrictedComponentTreeNode = Extract<HtmlTreeNode, { kind: "component" }> & {
  readonly logicalSourceRange: SourceRange;
};
type RestrictedHtmlComponentMarker = {
  readonly kind: "component";
  readonly name: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly status: "open" | "closed" | "incomplete";
  readonly logicalSourceRange: SourceRange;
  readonly rawSource: string;
  readonly diagnostic?: string;
};

type RestrictedInlinePlaceholder =
  | { readonly kind: "literal"; readonly raw: string; readonly node: HtmlTreeNode }
  | {
      readonly kind: "component";
      readonly component: RestrictedComponentTreeNode;
      readonly position: "open" | "close" | "self";
      readonly raw: string;
    };

type PreparedInlineMarker = {
  readonly openingRaw: string;
  readonly attribute: string;
  readonly value: string;
  readonly placeholder: RestrictedInlinePlaceholder;
};

type PreparedInlineRange = {
  readonly source: string;
  readonly markerAttribute: string;
  readonly markersByOpeningRaw: ReadonlyMap<string, PreparedInlineMarker>;
};

function prepareInlineRange(
  source: string,
  tokens: readonly RestrictedComponentSourceToken[],
  tags: readonly RestrictedComponentTag[],
  from: number,
  to: number,
  options?: RestrictedAdmissionOptions,
): PreparedInlineRange {
  let markerAttribute = "smdxrestrictedinline";
  const lowerSource = source.toLowerCase();
  while (lowerSource.includes(markerAttribute)) markerAttribute += "x";
  const markersByOpeningRaw = new Map<string, PreparedInlineMarker>();
  const closingComponents = new Map<number, RestrictedComponentTreeNode>();
  let nextMarker = 0;
  let prepared = "";
  let cursor = from;
  let tokenIndex = 0;

  const markerFor = (placeholder: RestrictedInlinePlaceholder): string => {
    const value = (nextMarker++).toString(36);
    const openingRaw = `<img ${markerAttribute}="${value}">`;
    markersByOpeningRaw.set(openingRaw, { openingRaw, attribute: markerAttribute, value, placeholder });
    return openingRaw;
  };
  const replaceRange = (
    start: number,
    end: number,
    placeholder: RestrictedInlinePlaceholder,
  ) => {
    prepared += source.slice(cursor, start);
    prepared += markerFor(placeholder);
    cursor = end;
  };
  const literalPlaceholder = (raw: string, diagnostic: string): RestrictedInlinePlaceholder => ({
    kind: "literal",
    raw,
    node: { kind: "text", text: raw, rawSource: raw, diagnostic },
  });

  while (tokenIndex < tokens.length) {
    const token = tokens[tokenIndex];
    const tokenTo = token.kind === "tag" ? token.tag.to : token.to;
    if (tokenTo > from) break;
    tokenIndex++;
  }

  while (tokenIndex < tokens.length) {
    const token = tokens[tokenIndex];
    const tokenFrom = token.kind === "tag" ? token.tag.from : token.from;
    if (tokenFrom >= to) break;
    if (tokenFrom < cursor) {
      tokenIndex++;
      continue;
    }

    if (token.kind === "literal") {
      replaceRange(token.from, token.to, literalPlaceholder(token.raw, token.diagnostic));
      tokenIndex++;
      continue;
    }

    const tag = token.tag;
    if (tag.kind === "close") {
      const component = closingComponents.get(tag.from);
      if (component) {
        replaceRange(tag.from, tag.to, { kind: "component", component, position: "close", raw: source.slice(tag.from, tag.to) });
      } else {
        const raw = source.slice(tag.from, tag.to);
        replaceRange(tag.from, tag.to, literalPlaceholder(raw, `Unexpected stray closing tag </${tag.name}>`));
      }
      tokenIndex++;
      continue;
    }

    if (tag.kind === "self-closing") {
      const component: RestrictedComponentTreeNode = {
        kind: "component",
        name: tag.name,
        props: tag.props,
        status: "closed",
        children: [],
        rawSource: source.slice(tag.from, tag.to),
        logicalSourceRange: { from: tag.from, to: tag.to },
      };
      replaceRange(tag.from, tag.to, { kind: "component", component, position: "self", raw: source.slice(tag.from, tag.to) });
      tokenIndex++;
      continue;
    }

    const rootMatch = findRootClosingTag(tag.name, tag, tags, to);
    if (rootMatch.kind === "mismatched") {
      const closing = rootMatch.closing;
      const raw = source.slice(tag.from, closing.to);
      replaceRange(
        tag.from,
        closing.to,
        literalPlaceholder(raw, `Mismatched closing tag </${closing.name}> while <${rootMatch.expected}> was open`),
      );
      tokenIndex++;
      while (tokenIndex < tokens.length) {
        const next = tokens[tokenIndex];
        const nextFrom = next.kind === "tag" ? next.tag.from : next.from;
        if (nextFrom >= cursor) break;
        tokenIndex++;
      }
      continue;
    }

    const matchingClose = rootMatch.kind === "closed" ? rootMatch.closing : undefined;
    const component: RestrictedComponentTreeNode = {
      kind: "component",
      name: tag.name,
      props: tag.props,
      status: matchingClose ? "closed" : options?.forceFinalize ? "incomplete" : "open",
      children: [],
      rawSource: source.slice(tag.from, matchingClose?.to ?? to),
      logicalSourceRange: { from: tag.from, to: matchingClose?.to ?? to },
      diagnostic: !matchingClose && options?.forceFinalize ? `Unclosed component tag <${tag.name}>` : undefined,
    };
    if (matchingClose) closingComponents.set(matchingClose.from, component);
    replaceRange(tag.from, tag.to, { kind: "component", component, position: "open", raw: source.slice(tag.from, tag.to) });
    tokenIndex++;
  }

  prepared += source.slice(cursor, to);
  return { source: prepared, markerAttribute, markersByOpeningRaw };
}

function createInlinePlaceholderReplacements(
  nodes: InlineNode[],
  prepared: PreparedInlineRange,
): {
  readonly replacements: ReadonlyMap<InlineNode, readonly InlineNode[]>;
  readonly placeholdersByIdentity: WeakMap<InlineNode, RestrictedInlinePlaceholder>;
  readonly metadataByIdentity: ReadonlyMap<InlineNode, InlineNode>;
} {
  const replacements = new Map<InlineNode, readonly InlineNode[]>();
  const placeholdersByIdentity = new WeakMap<InlineNode, RestrictedInlinePlaceholder>();
  const metadataByIdentity = new Map<InlineNode, InlineNode>();
  let found = 0;
  const restoreMarkerSource = (value: string): string => {
    let restored = value;
    for (const marker of prepared.markersByOpeningRaw.values()) {
      restored = restored.split(marker.openingRaw).join(marker.placeholder.raw);
    }
    return restored;
  };
  const restoreStringRecord = (record: Record<string, string>): Record<string, string> => {
    const restored: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) restored[key] = restoreMarkerSource(value);
    return restored;
  };
  const markerForNode = (node: InlineNode): PreparedInlineMarker | undefined => {
    if (node.kind !== "html" || !node.openingRaw) return undefined;
    const marker = prepared.markersByOpeningRaw.get(node.openingRaw);
    return marker
      && marker.attribute === prepared.markerAttribute
      && node.openingRaw === marker.openingRaw
      && node.tagName === "img"
      && node.isSelfClosing
      && node.openingRaw.includes(` ${marker.attribute}="${marker.value}"`)
      ? marker
      : undefined;
  };
  const scrubMetadata = (node: InlineNode): InlineNode => {
    const existing = metadataByIdentity.get(node);
    if (existing) return existing;
    const marker = markerForNode(node);
    if (marker) {
      const identity: InlineNode = {
        kind: "plugin",
        name: "restricted-component-placeholder",
        attrs: {},
        raw: "",
      };
      replacements.set(node, [identity]);
      placeholdersByIdentity.set(identity, marker.placeholder);
      const restored: InlineNode = { kind: "text", text: marker.placeholder.raw };
      metadataByIdentity.set(node, restored);
      found++;
      return restored;
    }

    let restored: InlineNode;
    switch (node.kind) {
      case "text":
        restored = { ...node, text: restoreMarkerSource(node.text) };
        break;
      case "strong":
      case "em":
      case "strike":
        restored = { ...node, children: node.children.map(scrubMetadata) };
        break;
      case "link":
        restored = {
          ...node,
          ...(node.href === undefined ? {} : { href: restoreMarkerSource(node.href) }),
          ...(node.title === undefined ? {} : { title: restoreMarkerSource(node.title) }),
          children: node.children.map(scrubMetadata),
        };
        break;
      case "code":
        restored = { ...node, text: restoreMarkerSource(node.text) };
        break;
      case "image":
        restored = {
          ...node,
          src: restoreMarkerSource(node.src),
          ...(node.alt === undefined ? {} : { alt: restoreMarkerSource(node.alt) }),
          ...(node.title === undefined ? {} : { title: restoreMarkerSource(node.title) }),
        };
        break;
      case "html":
        restored = {
          ...node,
          raw: restoreMarkerSource(node.raw),
          ...(node.openingRaw === undefined ? {} : { openingRaw: restoreMarkerSource(node.openingRaw) }),
          ...(node.closingRaw === undefined ? {} : { closingRaw: restoreMarkerSource(node.closingRaw) }),
          ...(node.sanitized === undefined ? {} : { sanitized: restoreMarkerSource(node.sanitized) }),
          ...(node.attributes === undefined ? {} : { attributes: restoreStringRecord(node.attributes) }),
          ...(node.children === undefined ? {} : { children: node.children.map(scrubMetadata) }),
        };
        break;
      case "plugin":
        restored = {
          ...node,
          raw: restoreMarkerSource(node.raw),
          attrs: restoreStringRecord(node.attrs),
          ...(node.children === undefined ? {} : { children: node.children.map(scrubMetadata) }),
        };
        break;
      case "trusted-mdx-inline":
        restored = { ...node, raw: restoreMarkerSource(node.raw) };
        break;
      case "mention":
        restored = { ...node, handle: restoreMarkerSource(node.handle) };
        break;
      case "citation":
        restored = { ...node, id: restoreMarkerSource(node.id) };
        break;
      case "math-inline":
      case "math-display":
        restored = { ...node, tex: restoreMarkerSource(node.tex) };
        break;
      case "footnote-ref":
        restored = { ...node, label: restoreMarkerSource(node.label) };
        break;
      case "br":
        restored = node;
        break;
    }
    metadataByIdentity.set(node, restored);
    return restored;
  };

  for (const node of nodes) scrubMetadata(node);
  if (found !== prepared.markersByOpeningRaw.size) {
    throw new Error("Configured inline parser did not preserve every restricted-component placeholder");
  }
  return { replacements, placeholdersByIdentity, metadataByIdentity };
}

function findInlinePlaceholder(
  node: HtmlTreeNode,
  placeholdersByIdentity: WeakMap<InlineNode, RestrictedInlinePlaceholder>,
): RestrictedInlinePlaceholder | undefined {
  return node.kind === "element" && node.inlineNode
    ? placeholdersByIdentity.get(node.inlineNode)
    : undefined;
}

function restoreInlinePlaceholders(
  nodes: HtmlTreeNode[],
  placeholdersByIdentity: WeakMap<InlineNode, RestrictedInlinePlaceholder>,
): HtmlTreeNode[] {
  const output: HtmlTreeNode[] = [];
  for (let index = 0; index < nodes.length;) {
    const node = nodes[index];
    const placeholder = findInlinePlaceholder(node, placeholdersByIdentity);
    if (!placeholder) {
      output.push(node.kind === "element"
        ? { ...node, children: restoreInlinePlaceholders(node.children, placeholdersByIdentity) }
        : node);
      index++;
      continue;
    }
    if (placeholder.kind === "literal") {
      output.push(placeholder.node);
      index++;
      continue;
    }
    if (placeholder.position === "self") {
      output.push(placeholder.component);
      index++;
      continue;
    }
    if (placeholder.position === "close") {
      output.push({
        kind: "text",
        text: placeholder.raw,
        rawSource: placeholder.raw,
        diagnostic: `Unexpected stray closing tag ${placeholder.raw}`,
      });
      index++;
      continue;
    }

    let nestedComponents = 0;
    let closingIndex = -1;
    for (let candidateIndex = index + 1; candidateIndex < nodes.length; candidateIndex++) {
      const candidate = findInlinePlaceholder(nodes[candidateIndex], placeholdersByIdentity);
      if (candidate?.kind !== "component") continue;
      if (candidate.position === "open") nestedComponents++;
      else if (candidate.position === "close") {
        if (nestedComponents === 0 && candidate.component === placeholder.component) {
          closingIndex = candidateIndex;
          break;
        }
        if (nestedComponents > 0) nestedComponents--;
      }
    }
    if (closingIndex >= 0) {
      placeholder.component.children = restoreInlinePlaceholders(
        nodes.slice(index + 1, closingIndex),
        placeholdersByIdentity,
      );
      output.push(placeholder.component);
      index = closingIndex + 1;
      continue;
    }
    if (placeholder.component.status === "open" || placeholder.component.status === "incomplete") {
      placeholder.component.children = restoreInlinePlaceholders(nodes.slice(index + 1), placeholdersByIdentity);
      output.push(placeholder.component);
      break;
    }
    output.push({
      kind: "text",
      text: placeholder.raw,
      rawSource: placeholder.raw,
      diagnostic: `Component <${placeholder.component.name}> crosses a native inline boundary`,
    });
    index++;
  }
  return output;
}

function buildInlineRange(
  source: string,
  tokens: readonly RestrictedComponentSourceToken[],
  tags: readonly RestrictedComponentTag[],
  from: number,
  to: number,
  options?: RestrictedAdmissionOptions,
): HtmlTreeNode[] {
  if (options?.parseInline) {
    const prepared = prepareInlineRange(source, tokens, tags, from, to, options);
    const rangeSource = source.slice(from, to);
    if (prepared.markersByOpeningRaw.size === 0) {
      const text = textNode(rangeSource, options.parseInline);
      return text ? [text] : [];
    }
    const nativeInline = options.parseInline(prepared.source);
    const { replacements, placeholdersByIdentity, metadataByIdentity } = createInlinePlaceholderReplacements(nativeInline, prepared);
    const normalized = normalizeNativeInlineParagraph(rangeSource, nativeInline, options.htmlOptions, replacements, metadataByIdentity);
    const paragraph = normalized.find((node) => node.kind === "element" && node.paragraphRoot);
    return restoreInlinePlaceholders(
      paragraph?.kind === "element" ? paragraph.children : normalized,
      placeholdersByIdentity,
    );
  }

  return buildInlineRangeWithoutNativeParser(source, tokens, tags, from, to, options);
}

function buildInlineRangeWithoutNativeParser(
  source: string,
  tokens: readonly RestrictedComponentSourceToken[],
  tags: readonly RestrictedComponentTag[],
  from: number,
  to: number,
  options?: RestrictedAdmissionOptions,
): HtmlTreeNode[] {
  const nodes: HtmlTreeNode[] = [];
  let cursor = from;
  let tokenIndex = 0;
  while (tokenIndex < tokens.length) {
    const token = tokens[tokenIndex];
    const tokenTo = token.kind === "tag" ? token.tag.to : token.to;
    if (tokenTo > from) break;
    tokenIndex++;
  }

  while (tokenIndex < tokens.length) {
    const token = tokens[tokenIndex];
    const tokenFrom = token.kind === "tag" ? token.tag.from : token.from;
    const tokenTo = token.kind === "tag" ? token.tag.to : token.to;
    if (tokenFrom >= to) break;
    if (tokenFrom < cursor) {
      tokenIndex++;
      continue;
    }
    const before = textNode(source.slice(cursor, tokenFrom), options?.parseInline);
    if (before) nodes.push(before);

    if (token.kind === "literal") {
      nodes.push({ kind: "text", text: token.raw, rawSource: token.raw, diagnostic: token.diagnostic });
      cursor = tokenTo;
      tokenIndex++;
      continue;
    }

    const tag = token.tag;
    if (tag.kind === "close") {
      const raw = source.slice(tag.from, tag.to);
      nodes.push({
        kind: "text",
        text: raw,
        rawSource: raw,
        diagnostic: `Unexpected stray closing tag </${tag.name}>`,
      });
      cursor = tag.to;
      tokenIndex++;
      continue;
    }

    if (tag.kind === "self-closing") {
      const component: RestrictedComponentTreeNode = {
        kind: "component",
        name: tag.name,
        props: tag.props,
        status: "closed",
        children: [],
        rawSource: source.slice(tag.from, tag.to),
        logicalSourceRange: { from: tag.from, to: tag.to },
      };
      nodes.push(component);
      tokenIndex++;
      continue;
    }

    const rootMatch = findRootClosingTag(tag.name, tag, tags, to);
    if (rootMatch.kind === "mismatched") {
      const closing = rootMatch.closing;
      const raw = source.slice(tag.from, closing.to);
      nodes.push({
        kind: "text",
        text: raw,
        rawSource: raw,
        diagnostic: `Mismatched closing tag </${closing.name}> while <${rootMatch.expected}> was open`,
      });
      cursor = closing.to;
      while (tokenIndex < tokens.length) {
        const next = tokens[tokenIndex];
        const nextFrom = next.kind === "tag" ? next.tag.from : next.from;
        if (nextFrom >= cursor) break;
        tokenIndex++;
      }
      continue;
    }
    const matchingClose = rootMatch.kind === "closed" ? rootMatch.closing : undefined;
    const bodyTo = matchingClose?.from ?? to;
    const children = buildInlineRangeWithoutNativeParser(source, tokens, tags, tag.to, bodyTo, options);
    const rootTo = matchingClose?.to ?? to;
    const closed = matchingClose !== undefined;
    const component: RestrictedComponentTreeNode = {
      kind: "component",
      name: tag.name,
      props: tag.props,
      status: closed ? "closed" : options?.forceFinalize ? "incomplete" : "open",
      children,
      rawSource: source.slice(tag.from, rootTo),
      logicalSourceRange: { from: tag.from, to: rootTo },
      diagnostic: !closed && options?.forceFinalize ? `Unclosed component tag <${tag.name}>` : undefined,
    };
    nodes.push(component);
    cursor = rootTo;
    while (tokenIndex < tokens.length) {
      const next = tokens[tokenIndex];
      const nextFrom = next.kind === "tag" ? next.tag.from : next.from;
      if (nextFrom >= cursor) break;
      tokenIndex++;
    }
  }

  const after = textNode(source.slice(cursor, to), options?.parseInline);
  if (after) nodes.push(after);
  return nodes;
}

/** Builds restricted component leaves inside any native inline source range. */
export function buildRestrictedComponentInlineTree(
  rawSource: string,
  contentComponents: ReadonlyMap<string, RestrictedComponentDescriptor>,
  options?: RestrictedAdmissionOptions,
): HtmlTreeNode[] | null {
  if (!rawSource.includes("<")) return null;
  const tokens = scanRestrictedComponentSource(rawSource, contentComponents, options?.parser, {
    literalTagContent: options?.literalTagContent,
    protectedRanges: options?.protectedRanges,
  });
  if (tokens.length === 0) return null;
  const tags = tokens.flatMap((token) => token.kind === "tag" ? [token.tag] : []);
  return buildInlineRange(rawSource, tokens, tags, 0, rawSource.length, options);
}

/**
 * Builds an HtmlTreeNode array for a single block or multi-block restricted component region.
 *
 * Native block children remain block leaves; their own ownership trees admit nested registered
 * components without reparsing them in the consumer.
 */
export function buildRestrictedComponentTree(
  rawSource: string,
  contentComponents: ReadonlyMap<string, RestrictedComponentDescriptor>,
  options?: RestrictedAdmissionOptions & {
    childrenBlocks?: Block[];
    childBlockRanges?: readonly { readonly block: Block; readonly from: number; readonly to: number }[];
    sourceOffset?: number;
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

  const located = locateRestrictedTag(rawSource, firstNonWhitespace);
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
  const tokens = scanRestrictedComponentSource(rawSource, contentComponents, options?.parser, {
    literalTagContent: options?.literalTagContent,
    protectedRanges: [...(options?.protectedRanges ?? []), ...protectedCodeRanges],
  });
  const tags = tokens.flatMap((token) => token.kind === "tag" ? [token.tag] : []);
  const rootMatch = opening.kind === "open"
    ? findRootClosingTag(componentName, opening, tags)
    : undefined;
  if (rootMatch?.kind === "mismatched") {
    const { closing, expected } = rootMatch;
    return literalComponentNode(
      rawSource,
      `Mismatched closing tag </${closing.name}> while <${expected}> was open`,
    );
  }
  const matchingClose = rootMatch?.kind === "closed" ? rootMatch.closing : undefined;
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
        children.push(...buildInlineRange(rawSource, tokens, tags, cursor, childFrom, options));
        if (childTo > childFrom) children.push({ kind: "block", block: childBlocks[index] });
        cursor = Math.max(cursor, childTo);
      }
      children.push(...buildInlineRange(rawSource, tokens, tags, cursor, closeStart, options));
    } else {
      for (const block of childBlocks) children.push({ kind: "block", block });
    }
  } else if (!isSelfClosing) {
    children.push(...buildInlineRange(rawSource, tokens, tags, opening.to, closeStart, options));
  }

  const component: RestrictedComponentTreeNode = {
    kind: "component",
    name: componentName,
    props: opening.props,
    status: isClosed ? "closed" : options?.forceFinalize ? "incomplete" : "open",
    children,
    rawSource: rawSource.slice(firstNonWhitespace, rootEnd),
    logicalSourceRange: { from: opening.from, to: rootEnd },
    diagnostic: !isClosed && options?.forceFinalize ? `Unclosed component tag <${componentName}>` : undefined,
  };
  const tree: HtmlTreeNode[] = [];
  tree.push(...buildInlineRange(rawSource, tokens, tags, 0, firstNonWhitespace, options));
  tree.push(component);
  tree.push(...buildInlineRange(rawSource, tokens, tags, rootEnd, rawSource.length, options));
  return tree;
}
function buildRegisteredContainerParagraphRange(
  source: string,
  tokens: readonly RestrictedComponentSourceToken[],
  tags: readonly RestrictedComponentTag[],
  from: number,
  to: number,
  options?: RestrictedAdmissionOptions,
): HtmlTreeNode[] {
  let paragraphFrom = from;
  let paragraphTo = to;
  while (paragraphFrom < paragraphTo && /\s/.test(source[paragraphFrom]!)) paragraphFrom++;
  while (paragraphTo > paragraphFrom && /\s/.test(source[paragraphTo - 1]!)) paragraphTo--;
  if (paragraphFrom === paragraphTo) return [];
  const children = buildInlineRange(source, tokens, tags, paragraphFrom, paragraphTo, options);
  if (children.length === 0) return [];
  return [{
    kind: "element",
    tagName: "p",
    attributes: {},
    children,
    paragraphRoot: true,
  }];
}

export function buildRegisteredContainerTree(
  rawSource: string,
  contentComponents: ReadonlyMap<string, RestrictedComponentDescriptor>,
  extensions: readonly ContainerExtensionSpec[],
  options?: RestrictedAdmissionOptions & {
    readonly childrenBlocks?: readonly Block[];
    readonly childBlockRanges?: readonly { readonly block: Block; readonly from: number; readonly to: number }[];
    readonly sourceOffset?: number;
  },
): HtmlTreeNode[] | null {
  if (extensions.length === 0) return null;
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
    range && childBlocks[index]?.type === "code" ? [{ from: range.from, to: range.to }] : [],
  );
  const delimiters = scanRegisteredContainerSource(rawSource, extensions, contentComponents, options?.parser, {
    literalTagContent: options?.literalTagContent,
    protectedRanges: [...(options?.protectedRanges ?? []), ...protectedCodeRanges],
    trailingLineTerminator: options?.trailingLineTerminator,
  });
  const openingEvent = delimiters.find(
    (event) => event.kind === "open" && rawSource.slice(0, event.from).trim().length === 0,
  );
  if (!openingEvent || openingEvent.kind !== "open") return null;
  const opening = openingEvent.opening;
  const closingEvent = delimiters.find(
    (event) => event.kind === "close" && event.opening === opening,
  );
  const isClosed = closingEvent !== undefined;
  const closeLineStart = closingEvent?.from ?? rawSource.length;
  const closeStart = closingEvent
    ? closeLineStart - (rawSource[closeLineStart - 1] === "\n" ? rawSource[closeLineStart - 2] === "\r" ? 2 : 1 : 0)
    : rawSource.length;
  const rootEnd = closingEvent?.to ?? rawSource.length;
  let bodyStart = openingEvent.to;
  if (rawSource[bodyStart] === "\r") bodyStart++;
  if (rawSource[bodyStart] === "\n") bodyStart++;

  const tokens = scanRestrictedComponentSource(rawSource, contentComponents, options?.parser, {
    literalTagContent: options?.literalTagContent,
    protectedRanges: [...(options?.protectedRanges ?? []), ...protectedCodeRanges],
  });
  const tags = tokens.flatMap((token) => token.kind === "tag" ? [token.tag] : []);
  const children: HtmlTreeNode[] = [];

  const canMapChildren = childRanges.length === childBlocks.length &&
    childRanges.every((range) =>
      range !== undefined &&
      range.from >= 0 &&
      range.to >= range.from &&
      range.to <= rawSource.length,
    );
  if (childBlocks.length > 0 && !canMapChildren) {
    for (const block of childBlocks) children.push({ kind: "block", block });
  } else {
    const nestedOpenings = delimiters.filter(
      (event): event is Extract<RegisteredContainerDelimiterEvent, { kind: "open" }> =>
        event.kind === "open"
        && event.opening !== opening
        && event.from >= bodyStart
        && event.from < closeStart,
    );
    let nestedCursor = bodyStart;
    let nestedIndex = 0;
    let childIndex = 0;
    while (nestedIndex < nestedOpenings.length || childIndex < childBlocks.length) {
      const nestedOpening = nestedOpenings[nestedIndex];
      const range = childRanges[childIndex];
      const childFrom = range ? Math.max(nestedCursor, range.from, bodyStart) : Number.POSITIVE_INFINITY;
      const childTo = range ? Math.min(range.to, closeStart) : Number.POSITIVE_INFINITY;
      if (nestedOpening && (!range || nestedOpening.from < childTo)) {
        const nestedClosing = delimiters.find(
          (event) => event.kind === "close" && event.opening === nestedOpening.opening,
        );
        if (nestedClosing && nestedClosing.to > closeStart) {
          nestedIndex++;
          continue;
        }
        children.push(...buildRegisteredContainerParagraphRange(rawSource, tokens, tags, nestedCursor, nestedOpening.from, options));
        const nestedEnd = nestedClosing?.to ?? closeStart;
        const nestedTree = buildRegisteredContainerTree(
          rawSource.slice(nestedOpening.from, nestedEnd),
          contentComponents,
          extensions,
          {
            forceFinalize: options?.forceFinalize,
            parseInline: options?.parseInline,
            parser: options?.parser,
            literalTagContent: options?.literalTagContent,
            htmlOptions: options?.htmlOptions,
          },
        );
        if (nestedTree) children.push(...nestedTree);
        nestedCursor = nestedEnd;
        nestedIndex++;
        while (childIndex < childBlocks.length) {
          const nestedRange = childRanges[childIndex];
          if (!nestedRange || nestedRange.to <= nestedEnd) {
            childIndex++;
            continue;
          }
          if (nestedRange.from < nestedEnd) {
            const remainingTo = Math.min(nestedRange.to, closeStart);
            children.push(...buildRegisteredContainerParagraphRange(rawSource, tokens, tags, nestedCursor, remainingTo, options));
            nestedCursor = Math.max(nestedCursor, remainingTo);
            childIndex++;
          }
          break;
        }
        if (!nestedClosing) break;
        continue;
      }
      if (!range) {
        nestedIndex++;
        continue;
      }
      children.push(...buildRegisteredContainerParagraphRange(rawSource, tokens, tags, nestedCursor, childFrom, options));
      if (childTo > childFrom) children.push({ kind: "block", block: childBlocks[childIndex]! });
      nestedCursor = Math.max(nestedCursor, childTo);
      childIndex++;
    }
    children.push(...buildRegisteredContainerParagraphRange(rawSource, tokens, tags, nestedCursor, closeStart, options));
  }

  const firstNonWhitespace = rawSource.search(/\S/);
  const component: RestrictedComponentTreeNode = {
    kind: "component",
    name: opening.component,
    props: opening.props,
    status: isClosed ? "closed" : options?.forceFinalize ? "incomplete" : "open",
    children,
    rawSource: rawSource.slice(firstNonWhitespace, rootEnd),
    logicalSourceRange: { from: openingEvent.from, to: rootEnd },
    diagnostic: !isClosed && options?.forceFinalize ? `Unclosed container :::${opening.name}` : undefined,
  };
  const tree: HtmlTreeNode[] = [];
  tree.push(...buildInlineRange(rawSource, tokens, tags, 0, firstNonWhitespace, options));
  tree.push(component);
  tree.push(...buildInlineRange(rawSource, tokens, tags, rootEnd, rawSource.length, options));
  return tree;
}
/** Admits registered tags inside sanitized native HTML while leaving its HTML ownership intact. */
export function buildRestrictedHtmlComponentTree(
  rawSource: string,
  contentComponents: ReadonlyMap<string, RestrictedComponentDescriptor>,
  options?: RestrictedAdmissionOptions & { htmlOptions?: HtmlOptions },
): HtmlTreeNode[] | null {
  const tokens = scanRestrictedComponentSource(rawSource, contentComponents, options?.parser, {
    literalTagContent: options?.literalTagContent,
    protectedRanges: options?.protectedRanges,
  });
  if (tokens.length === 0) return null;

  const tags = tokens.flatMap((token) => token.kind === "tag" ? [token.tag] : []);
  const markerNodes: InlineNode[] = [];
  const markerValues = new Map<InlineNode, RestrictedComponentSourceToken | RestrictedHtmlComponentMarker>();
  const replacements = new Map<number, string>();
  const matchedCloses = new Set<number>();
  const lowerSource = rawSource.toLowerCase();
  let markerAttribute = "smdxrestricted";
  while (lowerSource.includes(markerAttribute)) markerAttribute += "x";
  const addMarker = (value: RestrictedComponentSourceToken | RestrictedHtmlComponentMarker): number => {
    const markerNode: InlineNode = { kind: "text", text: "" };
    markerValues.set(markerNode, value);
    return markerNodes.push(markerNode) - 1;
  };

  for (const tag of tags) {
    if (tag.kind === "close") continue;
    const match = tag.kind === "open" ? findRootClosingTag(tag.name, tag, tags) : undefined;
    if (match?.kind === "mismatched") {
      return literalComponentNode(
        rawSource,
        `Mismatched closing tag </${match.closing.name}> while <${match.expected}> was open`,
      );
    }
    const closing = match?.kind === "closed" ? match.closing : undefined;
    const rawEnd = closing?.to ?? (tag.kind === "self-closing" ? tag.to : rawSource.length);
    const status = tag.kind === "self-closing" || closing
      ? "closed"
      : options?.forceFinalize ? "incomplete" : "open";
    const markerIndex = addMarker({
      kind: "component",
      name: tag.name,
      props: tag.props,
      status,
      rawSource: rawSource.slice(tag.from, rawEnd),
      diagnostic: status === "incomplete" ? `Unclosed component tag <${tag.name}>` : undefined,
      logicalSourceRange: { from: tag.from, to: rawEnd },
    });
    replacements.set(
      tag.from,
      tag.kind === "self-closing"
        ? `<span ${markerAttribute}="${markerIndex}"></span>`
        : `<span ${markerAttribute}="${markerIndex}">`,
    );
    if (closing) {
      replacements.set(closing.from, "</span>");
      matchedCloses.add(closing.from);
    }
  }

  for (const token of tokens) {
    if (token.kind === "literal") {
      const markerIndex = addMarker(token);
      replacements.set(token.from, `<span ${markerAttribute}="${markerIndex}"></span>`);
    } else if (token.tag.kind === "close" && !matchedCloses.has(token.tag.from)) {
      const raw = rawSource.slice(token.tag.from, token.tag.to);
      const markerIndex = addMarker({
        kind: "literal",
        from: token.tag.from,
        to: token.tag.to,
        name: token.tag.name,
        raw,
        diagnostic: `Unexpected stray closing tag </${token.tag.name}>`,
      });
      replacements.set(token.tag.from, `<span ${markerAttribute}="${markerIndex}"></span>`);
    }
  }

  const htmlParts: string[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const from = token.kind === "tag" ? token.tag.from : token.from;
    const to = token.kind === "tag" ? token.tag.to : token.to;
    htmlParts.push(rawSource.slice(cursor, from), replacements.get(from) ?? rawSource.slice(from, to));
    cursor = to;
  }
  htmlParts.push(rawSource.slice(cursor));
  const tree = sanitizeHtmlTreeInWorker(
    htmlParts.join(""),
    options?.htmlOptions,
    { attribute: markerAttribute, inline: markerNodes },
    options?.parseInline,
  );
  const replaceMarkers = (nodes: HtmlTreeNode[]): HtmlTreeNode[] => nodes.flatMap((node): HtmlTreeNode[] => {
    if (node.kind === "element" && node.inlineNode) {
      const marker = markerValues.get(node.inlineNode);
      if (marker?.kind === "literal") {
        return [{ kind: "text", text: marker.raw, rawSource: marker.raw, diagnostic: marker.diagnostic }];
      }
      if (marker?.kind === "component") {
        const component: RestrictedComponentTreeNode = {
          kind: "component",
          name: marker.name,
          props: marker.props,
          status: marker.status,
          children: replaceMarkers(node.children),
          rawSource: marker.rawSource,
          logicalSourceRange: marker.logicalSourceRange,
          diagnostic: marker.diagnostic,
        };
        return [component];
      }
    }
    if (node.kind === "element" || node.kind === "component") {
      return [{ ...node, children: replaceMarkers(node.children) }];
    }
    return [node];
  });
  return replaceMarkers(tree);
}
