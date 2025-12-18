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

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "96px 24px" }}>
      <article className="prose" dangerouslySetInnerHTML={{ __html: html }} />
    </main>
  );
}
