import { notFound } from "next/navigation";

import { findGuideBySlug, getAllGuideSlugs, readGuideFile } from "@/lib/guides";
import { getDocsShellSections, getGuideCollectionItems } from "@/lib/docs-nav";
import { deriveTocHeadingsFromBlocks, readGuideSnapshot } from "@/lib/snapshot-artifacts";
import { SnapshotArticle } from "@/components/articles/snapshot-article";
import { StreamingArticle } from "@/components/articles/streaming-article";
import { CollectionNavigation } from "@/components/collection-navigation";
import { DocsShell } from "@/components/docs/docs-shell";

export function generateStaticParams() {
  return getAllGuideSlugs().map((slug) => ({ slug }));
}

export default async function GuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const item = findGuideBySlug(slug);
  if (!item) return notFound();

  const snapshot = await readGuideSnapshot(slug);
  const markdown = await readGuideFile(item.file);
  const navItems = getGuideCollectionItems();
  const navSections = getDocsShellSections({ includeDocsHomeLink: true });

  return (
    <DocsShell
      sections={navSections}
      initialTocHeadings={snapshot ? (snapshot.tocHeadings ?? deriveTocHeadingsFromBlocks(snapshot.blocks)) : undefined}
    >
      {snapshot ? <SnapshotArticle blocks={snapshot.blocks} /> : <StreamingArticle content={markdown} />}
      <CollectionNavigation items={navItems} basePath="/docs/guides" />
    </DocsShell>
  );
}
