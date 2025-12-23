import fs from "node:fs/promises";
import path from "node:path";

import { SHOWCASE_ITEMS } from "@/content/showcase";

export { SHOWCASE_ITEMS };

function showcaseRoot(): string {
  return path.resolve(process.cwd(), "content", "showcase");
}

export function getAllShowcaseSlugs(): string[] {
  return SHOWCASE_ITEMS.map((item) => item.slug);
}

export function findShowcaseBySlug(slug: string) {
  return SHOWCASE_ITEMS.find((item) => item.slug === slug);
}

export async function readShowcaseFile(file: string): Promise<string> {
  return await fs.readFile(path.resolve(showcaseRoot(), file), "utf8");
}

