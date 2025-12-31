import { notFound } from "next/navigation";

import { ARTICLE_ITEMS, findArticleBySlug, getAllArticleSlugs, readArticleFile } from "@/lib/articles";
import { StreamingArticle } from "@/components/articles/streaming-article";
import { CollectionNavigation } from "@/components/collection-navigation";
import { TableOfContents } from "@/components/on-this-page";

export function generateStaticParams() {
  return getAllArticleSlugs().map((slug) => ({ slug }));
}

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const item = findArticleBySlug(slug);
  if (!item) return notFound();

  const markdown = await readArticleFile(item.file);
  const navItems = ARTICLE_ITEMS.map((article) => ({ slug: article.slug, title: article.title }));

  return (
    <>
      <StreamingArticle content={markdown} />
      <CollectionNavigation items={navItems} basePath="/articles" />
      <TableOfContents />
    </>
  );
}
