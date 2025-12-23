import { notFound } from "next/navigation";

import { findDocBySlug, getAllDocSlugs, readDocFile, renderMarkdownToHtml } from "../../../lib/docs";
import { DOC_SECTIONS } from "../../../lib/docs";
import { CollectionNavigation } from "@/components/collection-navigation";
import { TableOfContents } from "@/components/on-this-page";

export function generateStaticParams() {
  return getAllDocSlugs().map((slug) => ({ slug }));
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = findDocBySlug(slug);
  if (!doc) return notFound();

  const markdown = await readDocFile(doc.file);
  const html = await renderMarkdownToHtml(markdown);

  const navItems = DOC_SECTIONS.flatMap((section) => section.items)
    .filter((item) => item.slug.length > 0)
    .map((item) => ({ slug: item.slug, title: item.title }));

  return (
    <>
      <div
        id="article-content-wrapper"
        className="prose markdown flex flex-col space-y-3 text-theme-primary"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <CollectionNavigation items={navItems} basePath="/docs" />
      <TableOfContents />
    </>
  );
}
