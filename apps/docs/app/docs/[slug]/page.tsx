import { notFound } from "next/navigation";

import { findDocBySlug, getAllDocSlugs, readDocFile } from "../../../lib/docs";
import { DOC_SECTIONS } from "../../../lib/docs";
import { deriveTocHeadingsFromBlocks, readDocSnapshot } from "../../../lib/snapshot-artifacts";
import { SnapshotArticle } from "@/components/articles/snapshot-article";
import { StreamingArticle } from "@/components/articles/streaming-article";
import { CollectionNavigation } from "@/components/collection-navigation";
import { DocsShell } from "@/components/docs/docs-shell";
import { StreamRenderWidget } from "@/components/widgets/stream-render-widget";
import { getDocWidgetSample } from "@/lib/render-widget-samples";

export function generateStaticParams() {
  return getAllDocSlugs().map((slug) => ({ slug }));
}

function docHref(slug: string) {
  if (!slug) return "/docs";
  return `/docs/${slug}`;
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = findDocBySlug(slug);
  if (!doc) return notFound();

  const snapshot = await readDocSnapshot(slug);
  const markdown = await readDocFile(doc.file);

  const navItems = DOC_SECTIONS.flatMap((section) => section.items)
    .filter((item) => item.slug.length > 0)
    .map((item) => ({ slug: item.slug, title: item.title }));

  const navSections = DOC_SECTIONS.map((section) => ({
    title: section.title,
    items: section.items.map((item) => ({
      title: item.title,
      href: docHref(item.slug),
    })),
  }));
  const widgetSample = getDocWidgetSample(slug, doc.title);

  return (
    <DocsShell
      sections={navSections}
      initialTocHeadings={snapshot ? (snapshot.tocHeadings ?? deriveTocHeadingsFromBlocks(snapshot.blocks)) : undefined}
    >
      <div className="mb-6 w-full max-w-3xl">
        <StreamRenderWidget title={`${widgetSample.title} · live stream`} markdown={widgetSample.markdown} />
      </div>
      {snapshot ? <SnapshotArticle blocks={snapshot.blocks} /> : <StreamingArticle content={markdown} />}
      <CollectionNavigation items={navItems} basePath="/docs" />
    </DocsShell>
  );
}
