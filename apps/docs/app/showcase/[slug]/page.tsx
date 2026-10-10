import { notFound } from "next/navigation";
import { Link } from "next-view-transitions";

import { findShowcaseBySlug, getAllShowcaseSlugs, readShowcaseFile } from "@/lib/showcase";
import { SHOWCASE_ITEMS } from "@/lib/showcase";
import { readShowcaseSnapshot } from "@/lib/snapshot-artifacts";
import { SnapshotArticle } from "@/components/articles/snapshot-article";
import { StreamingArticle } from "@/components/articles/streaming-article";
import { CollectionNavigation } from "@/components/collection-navigation";
import { Button } from "@/components/ui/button";

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
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-10">
      <div className="flex flex-col gap-3">
        <div className="route-kicker">Showcase</div>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">{item.title}</h1>
        {item.description ? <p className="max-w-2xl text-[15px] leading-relaxed text-muted">{item.description}</p> : null}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
          {tags.map((tag) => (
            <span key={tag} className="rounded-full border border-border/70 bg-muted/15 px-2.5 py-0.5 font-medium">
              {tag}
            </span>
          ))}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="outline" className="h-8 rounded-full px-3 text-xs">
              <Link href="/demo">Open demo</Link>
            </Button>
            <Button asChild size="sm" variant="outline" className="h-8 rounded-full px-3 text-xs">
              <Link href="/docs">View docs</Link>
            </Button>
          </div>
        </div>
      </div>

      {/* The page header owns the title; the article's own leading h1 would repeat it. */}
      <div className="rounded-xl border border-border bg-background p-6 shadow-sm md:p-8 [&_.markdown-v2-output>h1:first-child]:hidden [&_.markdown-v2-output>:first-child:not(h1)]:mt-0 [&_.markdown-v2-output>h1:first-child+*]:mt-0">
        {snapshot ? <SnapshotArticle blocks={snapshot.blocks} /> : <StreamingArticle content={markdown} />}
      </div>

      <CollectionNavigation items={navItems} basePath="/showcase" />
    </div>
  );
}
