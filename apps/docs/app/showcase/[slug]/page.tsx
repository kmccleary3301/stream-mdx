import { notFound } from "next/navigation";
import { Link } from "next-view-transitions";

import { findShowcaseBySlug, getAllShowcaseSlugs, readShowcaseFile } from "@/lib/showcase";
import { SHOWCASE_ITEMS } from "@/lib/showcase";
import { readShowcaseSnapshot } from "@/lib/snapshot-artifacts";
import { SnapshotArticle } from "@/components/articles/snapshot-article";
import { StreamingArticle } from "@/components/articles/streaming-article";
import { CollectionNavigation } from "@/components/collection-navigation";

export function generateStaticParams() {
  return getAllShowcaseSlugs().map((slug) => ({ slug }));
}

export default async function ShowcasePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const item = findShowcaseBySlug(slug);
  if (!item) return notFound();

  const markdown = await readShowcaseFile(item.file);
  const snapshot = await readShowcaseSnapshot(slug);

  const navItems = SHOWCASE_ITEMS.map((showcaseItem) => ({ slug: showcaseItem.slug, title: showcaseItem.title }));
  const tags = item.tags.length > 0 ? item.tags : ["streaming"];

  return (
    <div className="mx-auto flex w-full max-w-screen-xl flex-col gap-6 px-4 py-10">
      <div className="flex flex-col gap-3">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Showcase</div>
        <h1 className="text-3xl font-semibold text-foreground">{item.title}</h1>
        {item.description ? <p className="max-w-2xl text-sm text-muted">{item.description}</p> : null}
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {tags.map((tag) => (
            <span key={tag} className="rounded-full border border-border/60 bg-background/40 px-3 py-1">
              {tag}
            </span>
          ))}
          <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
            <Link className="underline decoration-1 decoration-gray-a4 underline-offset-2" href="/demo">
              Open demo
            </Link>
            <Link className="underline decoration-1 decoration-gray-a4 underline-offset-2" href="/docs">
              View docs
            </Link>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-background p-6 shadow-sm">
        {snapshot ? <SnapshotArticle blocks={snapshot.blocks} /> : <StreamingArticle content={markdown} />}
      </div>

      <CollectionNavigation items={navItems} basePath="/showcase" />
    </div>
  );
}
