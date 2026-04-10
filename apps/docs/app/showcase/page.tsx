"use client";

import { useMemo, useState } from "react";
import { Link } from "next-view-transitions";

import { SHOWCASE_ITEMS } from "@/content/showcase";
import { cn } from "@/lib/utils";

export const dynamic = "force-static";

type FilterKey = "all" | "rendering" | "extensibility" | "safety" | "performance";

const filters: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "rendering", label: "Rendering" },
  { key: "extensibility", label: "Extensibility" },
  { key: "safety", label: "Safety" },
  { key: "performance", label: "Performance" },
];

export default function ShowcaseIndexPage() {
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();

  const filteredItems = useMemo(() => {
    const filterSetByKey: Record<Exclude<FilterKey, "all">, Set<string>> = {
      rendering: new Set(["rendering", "components", "mdx", "visualization"]),
      extensibility: new Set(["extensibility", "plugin", "mdx", "components"]),
      safety: new Set(["safety", "security", "testing"]),
      performance: new Set(["performance", "testing"]),
    };

    return SHOWCASE_ITEMS.filter((item) => {
      const tags = item.tags.length > 0 ? item.tags : ["streaming"];
      const matchesFilter =
        activeFilter === "all" ||
        tags.some((tag) => filterSetByKey[activeFilter as Exclude<FilterKey, "all">].has(tag));
      if (!matchesFilter) return false;
      if (!normalizedQuery) return true;
      const haystack = `${item.title} ${item.description ?? ""} ${tags.join(" ")}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [activeFilter, normalizedQuery]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-10">
      <header className="route-panel-hero flex flex-col gap-4 px-6 py-8 md:px-8">
        <div className="route-kicker">Showcase</div>
        <h1 className="text-3xl font-semibold text-foreground md:text-4xl">Feature-focused demos and references</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground md:text-base">
          Browse demos, harnesses, and integrations that highlight high-performance streaming behavior, design-system overrides, and
          reliability-oriented workflows.
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="route-chip">Implementation notes</span>
          <span className="route-chip">Reproducible scripts</span>
          <span className="route-chip">Feature-specific articles</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {filters.map((filter) => (
            <button
              key={filter.key}
              type="button"
              onClick={() => setActiveFilter(filter.key)}
              className={cn(
                "rounded-full border px-3 py-1.5 transition",
                activeFilter === filter.key
                  ? "border-foreground/20 bg-foreground/7 text-foreground shadow-[0_14px_32px_-28px_rgba(15,23,42,0.55)]"
                  : "border-border/50 bg-background/75 text-muted hover:border-border hover:text-foreground",
              )}
            >
              {filter.label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2 text-xs text-muted max-sm:w-full">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-9 w-52 rounded-full border border-border/50 bg-background/80 px-4 text-xs text-foreground placeholder:text-muted shadow-[0_14px_30px_-28px_rgba(15,23,42,0.55)] max-sm:w-full"
              placeholder="Search features..."
            />
          </div>
        </div>
        <div className="text-xs text-muted">
          Showing {filteredItems.length} of {SHOWCASE_ITEMS.length} showcases
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filteredItems.map((item) => (
          <div key={item.slug} className="route-grid-card flex flex-col p-5">
            <div className="text-sm font-semibold text-foreground">{item.title}</div>
            {item.description ? <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.description}</p> : null}
            <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-muted">
              {(item.tags.length > 0 ? item.tags : ["streaming"]).map((tag) => (
                <span key={tag} className="rounded-full border border-border/50 bg-background/70 px-2.5 py-1">
                  {tag}
                </span>
              ))}
            </div>
            <Link
              className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-foreground underline decoration-1 decoration-gray-a4 underline-offset-4"
              href={`/showcase/${item.slug}`}
            >
              Open
            </Link>
          </div>
        ))}
      </section>

      {filteredItems.length === 0 ? (
        <section className="route-panel p-6 text-sm text-muted">
          No showcase entries match this filter/query yet. Try clearing the search or switching filters.
        </section>
      ) : null}

      <section className="route-panel p-6 text-sm text-muted">
        <div className="route-kicker">How to use this page</div>
        <p className="mt-2">
          Each demo page includes implementation notes, toggles, and reproducible scripts. Use the perf harness to validate changes before
          publishing.
        </p>
      </section>
    </div>
  );
}
