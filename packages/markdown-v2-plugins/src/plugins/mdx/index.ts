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
      const baseOffset = typeof blockRange?.from === "number" ? blockRange.from : null;
      let protectedBase = baseOffset ?? 0;
      let relevantProtected = filterProtectedRanges(ctx.protectedRanges, protectedBase, protectedBase + raw.length);
      if (relevantProtected.length === 0) {
        const metaProtected = Array.isArray((block.payload.meta as { protectedRanges?: ProtectedRange[] } | undefined)?.protectedRanges)
          ? ((block.payload.meta as { protectedRanges?: ProtectedRange[] }).protectedRanges ?? [])
          : [];
        if (metaProtected.length > 0) {
          if (baseOffset === null) {
            protectedBase = 0;
            relevantProtected = metaProtected;
          } else {
            protectedBase = baseOffset;
            relevantProtected = metaProtected.map((range) => ({
              ...range,
              from: baseOffset + range.from,
              to: baseOffset + range.to,
            }));
          }
        }
      }
      if (detectMDX(raw, { protectedRanges: relevantProtected, baseOffset: protectedBase })) {
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
