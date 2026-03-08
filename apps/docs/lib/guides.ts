import fs from "node:fs/promises";
import path from "node:path";

import { GUIDE_ITEMS } from "@/content/guides";

export { GUIDE_ITEMS };

function guidesRoot(): string {
  return path.resolve(process.cwd(), "content", "guides");
}

export function getAllGuideSlugs(): string[] {
  return GUIDE_ITEMS.map((item) => item.slug);
}

export function findGuideBySlug(slug: string) {
  return GUIDE_ITEMS.find((item) => item.slug === slug);
}

export async function readGuideFile(file: string): Promise<string> {
  return await fs.readFile(path.resolve(guidesRoot(), file), "utf8");
}
