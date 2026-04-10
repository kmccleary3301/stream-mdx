import { notFound } from "next/navigation";

import { findDocBySlug, getAllDocSlugs, readDocFile } from "../../../lib/docs";
import { getDocCollectionItems, getDocsShellSections } from "@/lib/docs-nav";
import { deriveTocHeadingsFromBlocks, readDocSnapshot } from "../../../lib/snapshot-artifacts";
import { SnapshotArticle } from "@/components/articles/snapshot-article";
import { StreamingArticle } from "@/components/articles/streaming-article";
import { CollectionNavigation } from "@/components/collection-navigation";
import { DocsShell } from "@/components/docs/docs-shell";

export function generateStaticParams() {
  return getAllDocSlugs().map((slug) => ({ slug }));
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = findDocBySlug(slug);
  if (!doc) return notFound();

  const snapshot = await readDocSnapshot(slug);
  const markdown = await readDocFile(doc.file);

  const navItems = getDocCollectionItems();
  const navSections = getDocsShellSections({ includeDocsHomeLink: true });

  return (
    <DocsShell
      sections={navSections}
      initialTocHeadings={snapshot ? (snapshot.tocHeadings ?? deriveTocHeadingsFromBlocks(snapshot.blocks)) : undefined}
    >
      {snapshot ? <SnapshotArticle blocks={snapshot.blocks} /> : <StreamingArticle content={markdown} />}
      <CollectionNavigation items={navItems} basePath="/docs" />
    </DocsShell>
  );
}
