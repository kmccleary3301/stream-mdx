import type { Block } from "@stream-mdx/core";

export function publishedFootnoteLabels(blocks: ReadonlyArray<Block>): Set<string> {
  const footer = blocks.find((block) => block.type === "footnotes");
  const items = footer?.payload.meta?.items as Array<{ label: string }> | undefined;
  return new Set((items ?? []).map((item) => item.label));
}

export function projectFootnotePublication(block: Block, published: Set<string>): Block {
  // Only this footer-dependent flag is transient. Source, numbers, occurrence
  // IDs and every other serialized child field remain part of the strict oracle.
  const project = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(project);
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const result = Object.fromEntries(Object.entries(record).map(([key, child]) => [key, project(child)]));
    if (record.kind === "footnote-ref" && typeof record.defined === "boolean" && typeof record.label === "string") {
      result.defined = published.has(record.label);
    }
    return result;
  };
  return project(block) as Block;
}
