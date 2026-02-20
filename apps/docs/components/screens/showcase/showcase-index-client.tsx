"use client";

import { useMemo, useState } from "react";
import { Link } from "next-view-transitions";

import { cn } from "@/lib/utils";
import type { ShowcaseItem } from "@/content/showcase";

const FILTERS = [
  { id: "all", label: "All", matches: () => true },
  { id: "rendering", label: "Rendering", matches: (item: ShowcaseItem) => item.tags.includes("rendering") || item.tags.includes("mdx") },
  { id: "extensibility", label: "Extensibility", matches: (item: ShowcaseItem) => item.tags.includes("plugin") || item.tags.includes("extensibility") },
  { id: "safety", label: "Safety", matches: (item: ShowcaseItem) => item.tags.includes("testing") || item.tags.includes("components") },
  { id: "performance", label: "Performance", matches: (item: ShowcaseItem) => item.tags.includes("performance") },
] as const;

export function ShowcaseIndexClient({ items }: { items: ShowcaseItem[] }) {
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<(typeof FILTERS)[number]["id"]>("all");

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filter = FILTERS.find((item) => item.id === activeFilter) ?? FILTERS[0];

    return items.filter((item) => {
      if (!filter.matches(item)) return false;
      if (!normalized) return true;
      const haystack = `${item.title} ${item.description ?? ""} ${item.tags.join(" ")}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [activeFilter, items, query]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-10">
      <header className="flex flex-col gap-3">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Showcase</div>
        <h1 className="text-3xl font-semibold text-foreground">Feature-focused demos and references</h1>
        <p className="max-w-2xl text-sm text-muted">
          Browse demos, harnesses, and integrations that highlight high-performance streaming behavior.
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() => setActiveFilter(filter.id)}
              className={cn(
                "rounded-full border px-3 py-1 transition",
                activeFilter === filter.id
                  ? "border-foreground/20 bg-foreground/5 text-foreground"
                  : "border-border/40 bg-background text-muted hover:border-border hover:text-foreground",
              )}
            >
              {filter.label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2 text-xs text-muted">
            <input
              aria-label="Search showcase features"
              className="h-8 w-48 rounded-full border border-border/40 bg-background px-3 text-xs text-foreground placeholder:text-muted"
              placeholder="Search features..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {visibleItems.map((item) => (
          <div key={item.slug} className="rounded-lg border border-border/40 bg-background p-5">
            <div className="text-sm font-semibold text-foreground">{item.title}</div>
            {item.description ? <p className="mt-2 text-sm text-muted">{item.description}</p> : null}
            <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-muted">
              {item.tags.map((tag) => (
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

      {visibleItems.length === 0 ? (
        <section className="rounded-lg border border-border/40 bg-background p-6 text-sm text-muted">
          No showcase entries match your current filter/search. Clear filters to view all features.
        </section>
      ) : null}

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
