import type { ProtectedRange } from "@stream-mdx/core";
import { detectMDX } from "@stream-mdx/core";
import type { DocumentContext, DocumentPlugin } from "../document";

/**
 * MDX detection plugin (Option B):
 * - Retags blocks that contain MDX syntax to 'mdx'.
 * - This complements the worker's detectMDX check and helps in fallback paths.
 */
export const MDXDetectionPlugin: DocumentPlugin = {
  name: "mdx-detection",
  process(ctx: DocumentContext) {
    for (const block of ctx.blocks) {
      if (block.type !== "paragraph" && block.type !== "html") continue;
      const raw = block.payload.raw;
      const blockRange = block.payload.range;
      const baseOffset = typeof blockRange?.from === "number" ? blockRange.from : 0;
      const relevantProtected = filterProtectedRanges(ctx.protectedRanges, baseOffset, baseOffset + raw.length);
      if (detectMDX(raw, { protectedRanges: relevantProtected, baseOffset })) {
        block.payload.meta = { ...(block.payload.meta || {}), originalType: block.type };
        block.type = "mdx";
        if ("sanitizedHtml" in block.payload) {
          block.payload.sanitizedHtml = undefined;
        }
      }
    }
    return undefined;
  },
};

function filterProtectedRanges(ranges: DocumentContext["protectedRanges"], from: number, to: number): ProtectedRange[] {
  if (!ranges || ranges.length === 0) {
    return [];
  }
  return ranges.filter((range) => Number.isFinite(range.from) && Number.isFinite(range.to) && range.to > from && range.from < to);
}
