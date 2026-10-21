import { isDeepStrictEqual } from "node:util";
import type { Block, InlineNode } from "@stream-mdx/core";

const INLINE_SEQUENCE_FIELDS: Record<string, true> = { inline: true, inlines: true, nodes: true };
const INLINE_KINDS: Record<string, true> = {
  text: true,
  strong: true,
  em: true,
  strike: true,
  code: true,
  link: true,
  image: true,
  br: true,
  html: true,
  mention: true,
  citation: true,
  "math-inline": true,
  "math-display": true,
  "footnote-ref": true,
  plugin: true,
};

export type SemanticBlockComparison = {
  id: string;
  type: string;
  isFinalized: boolean;
  raw: string;
  range: Block["payload"]["range"];
  inline: InlineNode[] | null;
  meta: unknown;
};

function isBlock(value: unknown): value is Block {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const payload = candidate.payload;
  return typeof candidate.id === "string" && typeof candidate.type === "string" &&
    typeof candidate.isFinalized === "boolean" && payload !== null && typeof payload === "object" &&
    !Array.isArray(payload) && typeof (payload as Record<string, unknown>).raw === "string";
}
function hasManagedParagraphMirror(block: Block, meta: Record<string, unknown>): boolean {
  if (block.type !== "paragraph") return false;
  const paragraph = meta.paragraph;
  if (paragraph === null || typeof paragraph !== "object" || Array.isArray(paragraph)) return false;
  const mirror = paragraph as Record<string, unknown>;
  return mirror.paragraphOwnerId === block.id &&
    typeof mirror.raw === "string" &&
    Array.isArray(mirror.spans);
}


function isInlineNode(value: unknown): value is InlineNode {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.kind === "string" && INLINE_KINDS[candidate.kind] === true &&
    (candidate.kind !== "text" || typeof candidate.text === "string");
}

function isInlineNodeSequence(value: readonly unknown[]): value is readonly InlineNode[] {
  return value.length > 0 && value.every(isInlineNode);
}

function normalizeInlineNodes(nodes: readonly InlineNode[]): InlineNode[] {
  const normalized: InlineNode[] = [];
  for (const sourceNode of nodes) {
    const node = "children" in sourceNode && Array.isArray(sourceNode.children)
      ? { ...sourceNode, children: normalizeInlineNodes(sourceNode.children) } as InlineNode
      : sourceNode;
    const previous = normalized[normalized.length - 1];
    if (node.kind === "text" && previous?.kind === "text") {
      normalized[normalized.length - 1] = { kind: "text", text: previous.text + node.text };
    } else {
      normalized.push(node);
    }
  }
  return normalized;
}

export function normalizeSemanticDtoValue(value: unknown, key = "", inlineParent = false): unknown {
  if (isBlock(value)) return semanticBlockProjection(value);
  if (Array.isArray(value)) {
    if ((inlineParent || INLINE_SEQUENCE_FIELDS[key] === true) && isInlineNodeSequence(value)) {
      return normalizeInlineNodes(value);
    }
    if (key === "items" && value.every((item) => Array.isArray(item) && (item.length === 0 || isInlineNodeSequence(item)))) {
      return value.map((nodes) => normalizeInlineNodes(nodes as readonly InlineNode[]));
    }
    return value.map((child) => normalizeSemanticDtoValue(child));
  }
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const isInline = isInlineNode(value);
  return Object.fromEntries(
    Object.entries(record).map(([childKey, child]) => [
      childKey,
      normalizeSemanticDtoValue(child, childKey, isInline),
    ]),
  );
}

export function semanticBlockProjection(block: Block): SemanticBlockComparison {
  const meta = block.payload.meta ? { ...block.payload.meta } : null;
  // `preparedNested` is a derived projection of the generic owned child tree. Compare that public tree separately.
  if (meta) {
    delete meta.preparedNested;
    if (block.type === "list" && meta.start === undefined) delete meta.start;
    // Native item content/layout comes from its compared child tree and props, not this legacy bridge.
    if (block.type === "list-item") {
      delete meta.ordered;
      delete meta.loose;
      delete meta.inline;
      delete meta.text;
      if (meta.start === undefined) delete meta.start;
    }
    // Code-line decorations are owned and checked through the public code-line view after readiness.
    if (block.type === "code") {
      delete meta.tokenLines;
      // An identical override does not change the effective language.
      if (typeof meta.lang === "string" && meta.highlightLang === meta.lang) delete meta.highlightLang;
    }
    // A typed paragraph snapshot is a cold source-state mirror, not block semantics.
    if (hasManagedParagraphMirror(block, meta)) delete meta.paragraph;
  }
  return {
    id: block.id,
    type: block.type,
    isFinalized: block.isFinalized,
    raw: block.payload.raw,
    range: block.payload.range,
    inline: block.type === "list-item" && block.payload.inline?.length === 0
      ? null
      : block.payload.inline ? normalizeInlineNodes(block.payload.inline) : null,
    meta: normalizeSemanticDtoValue(meta),
  };
}

export function blocksSemanticallyEqual(left: Block, right: Block): boolean {
  return isDeepStrictEqual(semanticBlockProjection(left), semanticBlockProjection(right));
}

function provisionalTailProjection(currentTail: Block, prefixTail: Block): SemanticBlockComparison {
  const projection = semanticBlockProjection(currentTail);
  if (!currentTail.isFinalized && prefixTail.isFinalized) {
    return { ...projection, isFinalized: prefixTail.isFinalized };
  }
  return projection;
}

export function provisionalTailBlocksSemanticallyEqual(currentTail: Block, prefixTail: Block): boolean {
  return isDeepStrictEqual(
    provisionalTailProjection(currentTail, prefixTail),
    semanticBlockProjection(prefixTail),
  );
}

function describeSemanticProjectionDifference(a: SemanticBlockComparison, b: SemanticBlockComparison): string {
  const differences: string[] = [];
  if (a.id !== b.id) differences.push(`id (${a.id} vs ${b.id})`);
  if (a.type !== b.type) differences.push(`type (${a.type} vs ${b.type})`);
  if (a.isFinalized !== b.isFinalized) differences.push(`isFinalized (${a.isFinalized} vs ${b.isFinalized})`);
  if (!isDeepStrictEqual(a.range, b.range)) differences.push("source range mismatch");
  if (a.raw !== b.raw) differences.push(`raw (len ${a.raw.length} vs ${b.raw.length})`);
  if (!isDeepStrictEqual(a.inline, b.inline)) differences.push("inline semantic mismatch");
  if (!isDeepStrictEqual(a.meta, b.meta)) {
    const leftMeta = a.meta !== null && typeof a.meta === "object" && !Array.isArray(a.meta)
      ? a.meta as Record<string, unknown>
      : {};
    const rightMeta = b.meta !== null && typeof b.meta === "object" && !Array.isArray(b.meta)
      ? b.meta as Record<string, unknown>
      : {};
    const keys = new Set([...Object.keys(leftMeta), ...Object.keys(rightMeta)]);
    const changed = Array.from(keys).filter((key) => !isDeepStrictEqual(leftMeta[key], rightMeta[key]));
    differences.push(`meta mismatch on keys [${changed.join(", ")}]`);
  }
  return differences.length > 0 ? differences.join("; ") : "semantic block difference";
}

export function describeBlockSemanticDifference(left: Block, right: Block): string {
  return describeSemanticProjectionDifference(semanticBlockProjection(left), semanticBlockProjection(right));
}

export function describeProvisionalTailSemanticDifference(currentTail: Block, prefixTail: Block): string {
  return describeSemanticProjectionDifference(
    provisionalTailProjection(currentTail, prefixTail),
    semanticBlockProjection(prefixTail),
  );
}


