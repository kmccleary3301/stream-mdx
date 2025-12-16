import type { Block, NodeSnapshot, Patch, SetPropsBatchEntry } from "../types";

const DEFAULT_MAX_LIGHT_PATCHES_PER_CHUNK = 32;
const LIGHT_APPEND_LINE_THRESHOLD = 4;

function isBlockCandidate(value: unknown): value is Block {
  if (!value || typeof value !== "object") return false;
  return typeof (value as { id?: unknown }).id === "string" && typeof (value as { type?: unknown }).type === "string";
}

const LIGHTWEIGHT_NODE_TYPES = new Set([
  "paragraph",
  "paragraph-text",
  "blockquote",
  "blockquote-text",
  "heading",
  "heading-text",
  "list",
  "list-item",
  "list-item-text",
  "footnote-def",
  "footnotes",
]);

function isLightweightInsert(node?: NodeSnapshot | null): boolean {
  if (!node) return false;
  if (LIGHTWEIGHT_NODE_TYPES.has(node.type)) {
    return true;
  }
  const blockCandidate = (node.props as { block?: unknown } | undefined)?.block;
  if (isBlockCandidate(blockCandidate)) {
    const blockType = (blockCandidate as Block).type;
    return blockType === "paragraph" || blockType === "heading" || blockType === "blockquote" || blockType === "list";
  }
  return false;
}

function isHeavyPropsPayload(props: Record<string, unknown>): boolean {
  if ("html" in props) {
    return true;
  }
  if ("block" in props && isBlockCandidate((props as Record<string, unknown>).block)) {
    const block = (props as { block: Block }).block;
    if (block.type === "code" || block.type === "html") {
      return true;
    }
    if (typeof block.payload?.highlightedHtml === "string" || typeof block.payload?.sanitizedHtml === "string") {
      return true;
    }
    return true;
  }
  return false;
}

function isHeavySetProps(patch: Extract<Patch, { op: "setProps" }>): boolean {
  return isHeavyPropsPayload(patch.props ?? {});
}

function isHeavySetPropsBatch(entries: SetPropsBatchEntry[]): boolean {
  for (const entry of entries) {
    if (!entry) continue;
    if (isHeavyPropsPayload(entry.props ?? {})) {
      return true;
    }
  }
  return false;
}

export function isHeavyPatch(patch: Patch): boolean {
  switch (patch.op) {
    case "setHTML":
      return true;
    case "appendLines":
      return (patch.lines?.length ?? LIGHT_APPEND_LINE_THRESHOLD + 1) > LIGHT_APPEND_LINE_THRESHOLD;
    case "insertChild":
      return !isLightweightInsert(patch.node);
    case "replaceChild":
      return !isLightweightInsert(patch.node);
    case "deleteChild":
      return false;
    case "reorder":
      return false;
    case "setProps":
      return isHeavySetProps(patch);
    case "setPropsBatch":
      return isHeavySetPropsBatch(patch.entries ?? []);
    default:
      return false;
  }
}

export function splitPatchBatch(patches: Patch[], maxLightChunk = DEFAULT_MAX_LIGHT_PATCHES_PER_CHUNK): Patch[][] {
  if (patches.length === 0) return [];

  const groups: Patch[][] = [];
  let current: Patch[] = [];

  const flush = () => {
    if (current.length > 0) {
      groups.push(current);
      current = [];
    }
  };

  for (const patch of patches) {
    const heavy = isHeavyPatch(patch);
    if (heavy) {
      flush();
      groups.push([patch]);
      continue;
    }

    current.push(patch);
    if (current.length >= maxLightChunk) {
      flush();
    }
  }

  flush();

  return groups;
}

