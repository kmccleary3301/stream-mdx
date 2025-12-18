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

  return <div className="prose markdown flex flex-col space-y-3 text-theme-primary" dangerouslySetInnerHTML={{ __html: html }} />;
}
