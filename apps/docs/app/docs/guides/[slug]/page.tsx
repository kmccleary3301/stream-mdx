import { notFound } from "next/navigation";

import { GUIDE_ITEMS, findGuideBySlug, getAllGuideSlugs, readGuideFile } from "@/lib/guides";
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
  const navItems = GUIDE_ITEMS.map((guide) => ({ slug: guide.slug, title: guide.title }));
  const navSections = [
    {
      title: "Docs",
      items: [
        { title: "Docs home", href: "/docs" },
        { title: "Getting started", href: "/docs/getting-started" },
        { title: "Configuration", href: "/docs/configuration" },
        { title: "React integration", href: "/docs/react-integration" },
        { title: "Public API", href: "/docs/public-api" },
      ],
    },
    {
      title: "Guides",
      items: GUIDE_ITEMS.map((guide) => ({
        title: guide.title,
        href: `/docs/guides/${guide.slug}`,
      })),
    },
  ];

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
