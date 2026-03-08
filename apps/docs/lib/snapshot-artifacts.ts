import type { Block } from "@stream-mdx/core";
import type { TocHeading } from "@/lib/toc";

type SnapshotArtifactV1 = {
  version: 1;
  createdAt: string;
  hash: string;
  blocks: Block[];
  tocHeadings?: TocHeading[];
};

type SnapshotKind = "docs" | "guides";

async function readArtifact(kind: SnapshotKind, slug: string): Promise<SnapshotArtifactV1 | null> {
  // `.generated` exists on disk during dev/build, but can be inlined by Next into
  // the server bundle. This makes artifact reads deploy-safe on Vercel.
  if (typeof window !== "undefined") return null;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.resolve(process.cwd(), ".generated", "snapshots");
  const filePath = path.join(root, kind, `${slug}.json`);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as SnapshotArtifactV1;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.blocks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function readDocSnapshot(slug: string): Promise<SnapshotArtifactV1 | null> {
  return await readArtifact("docs", slug);
}

export async function readGuideSnapshot(slug: string): Promise<SnapshotArtifactV1 | null> {
  return await readArtifact("guides", slug);
}

export function deriveTocHeadingsFromBlocks(blocks: ReadonlyArray<Block>): TocHeading[] {
  const headings: TocHeading[] = [];
  for (const block of blocks) {
    if (block.type !== "heading") continue;
    const meta = (block.payload.meta ?? {}) as Record<string, unknown>;
    const id = typeof meta.headingId === "string" && meta.headingId.length > 0 ? meta.headingId : "";
    const text = typeof meta.headingText === "string" && meta.headingText.length > 0 ? meta.headingText : "";
    const level = typeof meta.headingLevel === "number" ? meta.headingLevel : 1;
    if (!id || !text) continue;
    headings.push({ id, text, level: Math.max(1, Math.min(6, level)), blockId: block.id });
  }
  return headings;
}
