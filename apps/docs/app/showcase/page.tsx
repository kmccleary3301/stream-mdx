import { Link } from "next-view-transitions";

import { cn } from "@/lib/utils";
import { SHOWCASE_ITEMS } from "@/lib/showcase";

export const dynamic = "force-static";

const filters = ["All", "Rendering", "Extensibility", "Safety", "Performance"];

const tagsBySlug: Record<string, string[]> = {
  "stream-mdx-devx-catalog": ["docs", "mdx"],
  "html-overrides": ["rendering", "components"],
  "custom-regex": ["plugin", "extensibility"],
  "mdx-components": ["mdx", "rendering"],
  "mermaid-diagrams": ["plugin", "visualization"],
  "perf-harness": ["performance", "testing"],
};

export default function ShowcaseIndexPage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-10">
      <header className="flex flex-col gap-3">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Showcase</div>
        <h1 className="text-3xl font-semibold text-foreground">Feature-focused demos and references</h1>
        <p className="max-w-2xl text-sm text-muted">
          Browse demos, harnesses, and integrations that highlight high-performance streaming behavior.
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {filters.map((filter, index) => (
            <span
              key={filter}
              className={cn(
                "rounded-full border px-3 py-1",
                index === 0 ? "border-foreground/20 bg-foreground/5 text-foreground" : "border-border/40 bg-background text-muted",
              )}
            >
              {filter}
            </span>
          ))}
          <div className="ml-auto flex items-center gap-2 text-xs text-muted">
            <input
              className="h-8 w-48 rounded-full border border-border/40 bg-background px-3 text-xs text-foreground placeholder:text-muted"
              placeholder="Search features..."
            />
          </div>
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {SHOWCASE_ITEMS.map((item) => (
          <div key={item.slug} className="rounded-lg border border-border/40 bg-background p-5">
            <div className="text-sm font-semibold text-foreground">{item.title}</div>
            {item.description ? <p className="mt-2 text-sm text-muted">{item.description}</p> : null}
            <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-muted">
              {(tagsBySlug[item.slug] ?? ["streaming"]).map((tag) => (
                <span key={tag} className="rounded-full border border-border/40 px-2 py-0.5">
                  {tag}
                </span>
              ))}
            </div>
            <Link
              className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-foreground underline decoration-1 decoration-gray-a4 underline-offset-4"
              href={`/showcase/${item.slug}`}
            >
              Open
            </Link>
          </div>
        ))}
      </section>

      <section className="rounded-lg border border-border/40 bg-muted/20 p-6 text-sm text-muted">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">How to use this page</div>
        <p className="mt-2">
          Each demo page includes implementation notes, toggles, and reproducible scripts. Use the perf harness to validate changes before
          publishing.
        </p>
      </section>
    </div>
  );
}
