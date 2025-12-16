import type { Patch } from "@stream-mdx/core";

function isParagraphBoundaryPatch(patch: Patch): boolean {
  if (patch.op === "finalize") {
    return true;
  }

  if (
    (patch.op === "insertChild" || patch.op === "replaceChild") &&
    patch.node &&
    typeof patch.node === "object" &&
    (patch.node as { type?: unknown }).type === "paragraph"
  ) {
    return true;
  }

  if (patch.op === "setProps" && typeof patch.at?.nodeId === "string" && patch.at.nodeId.includes("paragraph")) {
    return true;
  }

  return false;
}

function countParagraphBoundaries(patches: Patch[]): number {
  let count = 0;
  for (const patch of patches) {
    if (isParagraphBoundaryPatch(patch)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Determine whether we should cap the number of immediate patches emitted for
 * the current diff. Large patch bursts that include multiple paragraph or finalize
 * operations tend to stall the render queue; by clamping the immediate payload and
 * letting the deferred queue trickle we keep DOM cadence smoother without
 * starving the renderer.
 */
export function computeParagraphPatchLimit(
  patches: Patch[],
  {
    largePatchThreshold = 80,
    baseLimit = 64,
    finalizeLimit = 48,
  }: {
    largePatchThreshold?: number;
    baseLimit?: number;
    finalizeLimit?: number;
  } = {},
): number | null {
  if (!Array.isArray(patches) || patches.length < largePatchThreshold) {
    return null;
  }

  const paragraphBoundaries = countParagraphBoundaries(patches);
  if (paragraphBoundaries === 0) {
    return null;
  }

  // If we already hit finalize patches, clamp harder so the DOM can commit a clean paragraph
  const hasFinalize = patches.some((patch) => patch.op === "finalize");
  if (hasFinalize) {
    return Math.min(Math.max(16, finalizeLimit), patches.length);
  }

  // Otherwise scale the limit based on how many boundaries we saw.
  // More boundaries → smaller burst to keep cadence predictable.
  const scaledLimit = Math.max(32, Math.min(baseLimit, baseLimit - (paragraphBoundaries - 1) * 8));
  return Math.min(scaledLimit, patches.length);
}
