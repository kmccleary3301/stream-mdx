import { notFound } from "next/navigation";
import { Link } from "next-view-transitions";

import { findShowcaseBySlug, getAllShowcaseSlugs, readShowcaseFile } from "@/lib/showcase";
import { SHOWCASE_ITEMS } from "@/lib/showcase";
import { CollectionNavigation } from "@/components/collection-navigation";
import { StreamRenderWidget } from "@/components/widgets/stream-render-widget";
import { getShowcaseWidgetSample } from "@/lib/render-widget-samples";
import { StreamingArticle } from "@/components/articles/streaming-article";

export function generateStaticParams() {
  return getAllShowcaseSlugs().map((slug) => ({ slug }));
}

export default async function ShowcasePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const item = findShowcaseBySlug(slug);
  if (!item) return notFound();

  const markdown = await readShowcaseFile(item.file);

  const navItems = SHOWCASE_ITEMS.map((showcaseItem) => ({ slug: showcaseItem.slug, title: showcaseItem.title }));
  const tags = item.tags.length > 0 ? item.tags : ["streaming"];
  const widgetSample = getShowcaseWidgetSample(slug, item.title);

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
            <Link className="underline decoration-1 decoration-gray-a4 underline-offset-2" href={item.demoHref ?? "/demo"}>
              Open demo
            </Link>
            <Link className="underline decoration-1 decoration-gray-a4 underline-offset-2" href={item.docsHref ?? "/docs"}>
              View docs
            </Link>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-background p-6 shadow-sm">
        <div className="mb-6">
          <StreamRenderWidget title={`${widgetSample.title} · live stream`} markdown={widgetSample.markdown} />
        </div>
        <StreamingArticle content={markdown} />
      </div>

      <CollectionNavigation items={navItems} basePath="/showcase" />
    </div>
  );
}
