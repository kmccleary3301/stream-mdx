import { notFound } from "next/navigation";

import { findShowcaseBySlug, getAllShowcaseSlugs, readShowcaseFile } from "@/lib/showcase";
import { renderMarkdownToHtml } from "@/lib/docs";
import { SHOWCASE_ITEMS } from "@/lib/showcase";
import { CollectionNavigation } from "@/components/collection-navigation";
import { TableOfContents } from "@/components/on-this-page";

export function generateStaticParams() {
  return getAllShowcaseSlugs().map((slug) => ({ slug }));
}

export default async function ShowcasePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const item = findShowcaseBySlug(slug);
  if (!item) return notFound();

  const markdown = await readShowcaseFile(item.file);
  const html = await renderMarkdownToHtml(markdown);

  const navItems = SHOWCASE_ITEMS.map((showcaseItem) => ({ slug: showcaseItem.slug, title: showcaseItem.title }));

  return (
    <>
      <div
        id="article-content-wrapper"
        className="prose markdown flex flex-col space-y-3 text-theme-primary"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <CollectionNavigation items={navItems} basePath="/showcase" />
      <TableOfContents />
    </>
  );
}
