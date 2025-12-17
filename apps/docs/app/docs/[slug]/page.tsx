import { notFound } from "next/navigation";

import { findDocBySlug, getAllDocSlugs, readDocFile, renderMarkdownToHtml } from "../../../lib/docs";

export function generateStaticParams() {
  return getAllDocSlugs().map((slug) => ({ slug }));
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = findDocBySlug(slug);
  if (!doc) return notFound();

  const markdown = await readDocFile(doc.file);
  const html = await renderMarkdownToHtml(markdown);

  return <article className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
