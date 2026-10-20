import type { Block, HtmlTreeNode, InlineNode, NodeSnapshot } from "./types";


export type ParagraphBlockState = "open" | "closed" | "finalized";

/** Exact source frontier and owner revision for one root paragraph. */
export interface ParagraphBlockSourceMetadata {
  readonly paragraphOwnerId: string;
  readonly generation: number;
  readonly revision: number;
  readonly state: ParagraphBlockState;
  readonly processedTo: number;
  readonly completeSpanCount: number;
  readonly spanCount: number;
  readonly sourceRange: { readonly from: number; readonly to: number };
}

/** Cold snapshot only; routine append patches carry changed span records and source suffixes. */
export interface ParagraphBlockSnapshot extends ParagraphBlockSourceMetadata {
  readonly spans: readonly ParagraphSpanRecord[];
  readonly raw: string;
}
export interface ParagraphSpanChildSnapshot extends Pick<NodeSnapshot, "id" | "props" | "meta"> {
  readonly type: "paragraph-text" | "paragraph-html" | "paragraph-mdx";
  readonly range: { readonly from: number; readonly to: number };
}


export interface ParagraphSpanRecord {
  readonly id: string;
  readonly index: number;
  /** Authored absolute UTF-16 half-open source offsets. */
  readonly sourceRange: { readonly from: number; readonly to: number };
  /** Changes only when this span's authored provisional source is replaced. */
  readonly sourceRevision: number;
  readonly isProvisional: boolean;
  readonly nodes: readonly InlineNode[];
  /** Normalized link-reference labels attempted by the configured inline parser. */
  readonly attemptedReferences: readonly string[];
  /** Absolute-range mixed HTML/MDX/text children owned by this source span. */
  readonly children?: readonly ParagraphSpanChildSnapshot[];
}

export interface ParagraphSpanUpdate {
  readonly index: number;
  readonly expectedSourceRevision: number;
  readonly span: ParagraphSpanRecord;
}

export interface ParagraphSpanIndex {
  readonly length: number;
  readonly completeSpanCount: number;
  readonly revision: number;
  get(index: number): ParagraphSpanRecord | undefined;
  readRange(from: number, to: number): readonly ParagraphSpanRecord[];
  /** Replaces only the provisional tail; authored completed spans cannot be edited. */
  replaceTail(from: number, spans: readonly ParagraphSpanRecord[]): ParagraphSpanIndex;
  /** Changes prepared inline meaning while retaining every source identity field. */
  updateSpans(updates: readonly ParagraphSpanUpdate[]): ParagraphSpanIndex;
  /** Explicit cold copy of all immutable span records. */
  materialize(): readonly ParagraphSpanRecord[];
}

const frozenRecords = new WeakSet<object>();

function freezeInlineChildren(children: readonly InlineNode[]): InlineNode[] {
  const owned = children.map(freezeInlineNode);
  Object.freeze(owned);
  return owned;
}

function freezeStringRecord(values: Record<string, string>): Record<string, string> {
  const owned: Record<string, string> = { ...values };
  Object.freeze(owned);
  return owned;
}

function freezeInlineNode(node: InlineNode): InlineNode {
  switch (node.kind) {
    case "text": {
      const owned: Extract<InlineNode, { kind: "text" }> = { kind: "text", text: node.text };
      Object.freeze(owned);
      return owned;
    }
    case "strong": {
      const owned: Extract<InlineNode, { kind: "strong" }> = {
        kind: "strong",
        children: freezeInlineChildren(node.children),
      };
      Object.freeze(owned);
      return owned;
    }
    case "em": {
      const owned: Extract<InlineNode, { kind: "em" }> = {
        kind: "em",
        children: freezeInlineChildren(node.children),
      };
      Object.freeze(owned);
      return owned;
    }
    case "strike": {
      const owned: Extract<InlineNode, { kind: "strike" }> = {
        kind: "strike",
        children: freezeInlineChildren(node.children),
      };
      Object.freeze(owned);
      return owned;
    }
    case "code": {
      const owned: Extract<InlineNode, { kind: "code" }> = { kind: "code", text: node.text };
      Object.freeze(owned);
      return owned;
    }
    case "link": {
      const owned: Extract<InlineNode, { kind: "link" }> = {
        kind: "link",
        children: freezeInlineChildren(node.children),
      };
      if (node.href !== undefined) owned.href = node.href;
      if (node.title !== undefined) owned.title = node.title;
      if (node.autolink !== undefined) owned.autolink = node.autolink;
      Object.freeze(owned);
      return owned;
    }
    case "image": {
      const owned: Extract<InlineNode, { kind: "image" }> = { kind: "image", src: node.src };
      if (node.alt !== undefined) owned.alt = node.alt;
      if (node.title !== undefined) owned.title = node.title;
      Object.freeze(owned);
      return owned;
    }
    case "br": {
      const owned: Extract<InlineNode, { kind: "br" }> = { kind: "br" };
      Object.freeze(owned);
      return owned;
    }
    case "html": {
      const owned: Extract<InlineNode, { kind: "html" }> = { kind: "html", raw: node.raw };
      if (node.openingRaw !== undefined) owned.openingRaw = node.openingRaw;
      if (node.closingRaw !== undefined) owned.closingRaw = node.closingRaw;
      if (node.sanitized !== undefined) owned.sanitized = node.sanitized;
      if (node.tagName !== undefined) owned.tagName = node.tagName;
      if (node.isClose !== undefined) owned.isClose = node.isClose;
      if (node.isSelfClosing !== undefined) owned.isSelfClosing = node.isSelfClosing;
      if (node.attributes !== undefined) owned.attributes = freezeStringRecord(node.attributes);
      if (node.children !== undefined) owned.children = freezeInlineChildren(node.children);
      Object.freeze(owned);
      return owned;
    }
    case "mention": {
      const owned: Extract<InlineNode, { kind: "mention" }> = { kind: "mention", handle: node.handle };
      Object.freeze(owned);
      return owned;
    }
    case "citation": {
      const owned: Extract<InlineNode, { kind: "citation" }> = { kind: "citation", id: node.id };
      Object.freeze(owned);
      return owned;
    }
    case "math-inline": {
      const owned: Extract<InlineNode, { kind: "math-inline" }> = { kind: "math-inline", tex: node.tex };
      Object.freeze(owned);
      return owned;
    }
    case "math-display": {
      const owned: Extract<InlineNode, { kind: "math-display" }> = { kind: "math-display", tex: node.tex };
      Object.freeze(owned);
      return owned;
    }
    case "footnote-ref": {
      const owned: Extract<InlineNode, { kind: "footnote-ref" }> = { kind: "footnote-ref", label: node.label };
      if (node.number !== undefined) owned.number = node.number;
      if (node.occurrence !== undefined) owned.occurrence = node.occurrence;
      if (node.defined !== undefined) owned.defined = node.defined;
      Object.freeze(owned);
      return owned;
    }
    case "plugin": {
      const owned: Extract<InlineNode, { kind: "plugin" }> = {
        kind: "plugin",
        name: node.name,
        attrs: freezeStringRecord(node.attrs),
        raw: node.raw,
      };
      if (node.children !== undefined) owned.children = freezeInlineChildren(node.children);
      Object.freeze(owned);
      return owned;
    }
    default: {
      const unreachable: never = node;
      return unreachable;
    }
  }
}

function freezeStrings(values: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(values)) throw new TypeError(`Paragraph span ${field} must be an array`);
  const copy = new Array<string>(values.length);
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== "string") throw new TypeError(`Paragraph span ${field} entries must be strings`);
    if (seen.has(value)) continue;
    seen.add(value);
    copy[index] = value;
  }
  const compact = copy.filter((value): value is string => value !== undefined);
  compact.sort();
  return Object.freeze(compact);
}

function freezeOwnedValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeOwnedValue));
  if (typeof value !== "object" || value === null) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) copy[key] = freezeOwnedValue(nested);
  return Object.freeze(copy);
}

function freezeParagraphChildBlock(block: Block): Block {
  const payload = { ...block.payload };
  if (payload.inline) {
    const inline = payload.inline.map(freezeInlineNode);
    Object.freeze(inline);
    payload.inline = inline;
  }
  if (payload.range) payload.range = Object.freeze({ ...payload.range });
  if (payload.meta) payload.meta = freezeOwnedValue(payload.meta) as typeof payload.meta;
  return Object.freeze({ ...block, payload: Object.freeze(payload) });
}

function freezeParagraphChildHtmlNode(node: HtmlTreeNode): HtmlTreeNode {
  if (node.kind === "text") {
    const inline = node.inline?.map(freezeInlineNode);
    if (inline) Object.freeze(inline);
    const owned: Extract<HtmlTreeNode, { kind: "text" }> = {
      kind: "text",
      text: node.text,
      ...(inline ? { inline } : {}),
    };
    return Object.freeze(owned);
  }
  if (node.kind === "element") {
    const children = node.children.map(freezeParagraphChildHtmlNode);
    Object.freeze(children);
    const owned: Extract<HtmlTreeNode, { kind: "element" }> = {
      kind: "element",
      tagName: node.tagName,
      attributes: freezeStringRecord(node.attributes),
      children,
      ...(node.inlineNode ? { inlineNode: freezeInlineNode(node.inlineNode) } : {}),
      ...(node.paragraphRoot === undefined ? {} : { paragraphRoot: node.paragraphRoot }),
    };
    return Object.freeze(owned);
  }
  return Object.freeze({ kind: "block", block: freezeParagraphChildBlock(node.block) });
}

function freezeParagraphSpanChildSnapshot(child: ParagraphSpanChildSnapshot): ParagraphSpanChildSnapshot {
  if (typeof child.id !== "string" || !["paragraph-text", "paragraph-html", "paragraph-mdx"].includes(child.type)) {
    throw new TypeError("Paragraph span child snapshots require stable ids and a supported paragraph child type");
  }
  const range = child.range;
  if (!range || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)
    || range.from < 0 || range.to <= range.from) {
    throw new RangeError("Paragraph span child ranges must be absolute UTF-16 ranges");
  }
  const props = child.props ? { ...child.props } : undefined;
  if (props && Array.isArray(props.inline)) {
    props.inline = Object.freeze((props.inline as InlineNode[]).map(freezeInlineNode));
  }
  if (props) {
    for (const key of ["htmlTree", "htmlParagraphTree"]) {
      const tree = props[key];
      if (Array.isArray(tree)) props[key] = Object.freeze((tree as HtmlTreeNode[]).map(freezeParagraphChildHtmlNode));
    }
    if (props.block && typeof props.block === "object" && "payload" in props.block) {
      props.block = freezeParagraphChildBlock(props.block as Block);
    }
    for (const key of ["meta", "lookahead"]) {
      const value = props[key];
      if (value !== undefined) props[key] = freezeOwnedValue(value);
    }
  }
  return Object.freeze({
    id: child.id,
    type: child.type,
    range: Object.freeze({ from: range.from, to: range.to }),
    ...(props ? { props: Object.freeze(props) } : {}),
    ...(child.meta ? { meta: freezeOwnedValue(child.meta) as Record<string, unknown> } : {}),
  });
}

export function freezeParagraphSpanRecord(record: ParagraphSpanRecord): ParagraphSpanRecord {
  if (frozenRecords.has(record)) return record;
  if (typeof record !== "object" || record === null) throw new TypeError("Paragraph span records must be objects");
  if (typeof record.id !== "string") throw new TypeError("Paragraph span id must be a string");
  if (!Number.isSafeInteger(record.index) || record.index < 0) throw new RangeError("Paragraph span index must be a non-negative safe integer");
  if (!Number.isSafeInteger(record.sourceRevision) || record.sourceRevision < 0) {
    throw new RangeError("Paragraph span sourceRevision must be a non-negative safe integer");
  }
  if (typeof record.isProvisional !== "boolean") throw new TypeError("Paragraph span isProvisional must be a boolean");
  const range = record.sourceRange;
  if (typeof range !== "object" || range === null
    || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)
    || range.from < 0 || range.to < range.from) {
    throw new RangeError("Paragraph span sourceRange must be an ordered absolute UTF-16 range");
  }
  if (!Array.isArray(record.nodes)) throw new TypeError("Paragraph span nodes must be an array");
  const nodes = Object.freeze(record.nodes.map(freezeInlineNode));
  let children: readonly ParagraphSpanChildSnapshot[] | undefined;
  if (record.children !== undefined) {
    if (!Array.isArray(record.children) || record.children.length === 0) {
      throw new TypeError("Paragraph span native children must be a non-empty array");
    }
    if (nodes.length > 0) throw new TypeError("Paragraph spans cannot carry both inline nodes and native children");
    const copies = record.children.map(freezeParagraphSpanChildSnapshot);
    let cursor = range.from;
    for (const child of copies) {
      if (child.range.from !== cursor || child.range.to > range.to) {
        throw new RangeError("Paragraph span child ranges must partition the absolute span range in source order");
      }
      cursor = child.range.to;
    }
    if (cursor !== range.to) {
      throw new RangeError("Paragraph span child ranges must cover the exact absolute span range");
    }
    children = Object.freeze(copies);
  }
  const frozen: ParagraphSpanRecord = Object.freeze({
    id: record.id,
    index: record.index,
    sourceRange: Object.freeze({ from: range.from, to: range.to }),
    sourceRevision: record.sourceRevision,
    isProvisional: record.isProvisional,
    nodes,
    attemptedReferences: freezeStrings(record.attemptedReferences, "attemptedReferences"),
    ...(children === undefined ? {} : { children }),
  });
  frozenRecords.add(frozen);
  return frozen;
}
