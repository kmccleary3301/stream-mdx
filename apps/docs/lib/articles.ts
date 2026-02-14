import fs from "node:fs/promises";
import path from "node:path";

import { ARTICLE_ITEMS } from "@/content/articles";

export { ARTICLE_ITEMS };

function articlesRoot(): string {
  return path.resolve(process.cwd(), "content", "articles");
}

export function getAllArticleSlugs(): string[] {
  return ARTICLE_ITEMS.map((item) => item.slug);
}

export function findArticleBySlug(slug: string) {
  return ARTICLE_ITEMS.find((item) => item.slug === slug);
}

export async function readArticleFile(file: string): Promise<string> {
  return await fs.readFile(path.resolve(articlesRoot(), file), "utf8");
}
