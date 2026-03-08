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

const tagsBySlug: Record<string, string[]> = {
  "stream-mdx-devx-catalog": ["docs", "mdx", "performance", "safety"],
  "html-overrides": ["rendering", "components", "safety"],
  "custom-regex": ["plugin", "extensibility", "rendering"],
  "mdx-components": ["mdx", "rendering", "extensibility", "safety"],
  "mermaid-diagrams": ["plugin", "visualization", "rendering"],
  "perf-harness": ["performance", "testing", "safety"],
};

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
      const tags = tagsBySlug[item.slug] ?? ["streaming"];
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
      <header className="flex flex-col gap-3">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Showcase</div>
        <h1 className="text-3xl font-semibold text-foreground">Feature-focused demos and references</h1>
        <p className="max-w-2xl text-sm text-muted">
          Browse demos, harnesses, and integrations that highlight high-performance streaming behavior.
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {filters.map((filter) => (
            <button
              key={filter.key}
              type="button"
              onClick={() => setActiveFilter(filter.key)}
              className={cn(
                "rounded-full border px-3 py-1 transition",
                activeFilter === filter.key
                  ? "border-foreground/20 bg-foreground/5 text-foreground"
                  : "border-border/40 bg-background text-muted hover:text-foreground",
              )}
            >
              {filter.label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2 text-xs text-muted max-sm:w-full">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-8 w-48 rounded-full border border-border/40 bg-background px-3 text-xs text-foreground placeholder:text-muted max-sm:w-full"
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

      {filteredItems.length === 0 ? (
        <section className="rounded-lg border border-border/40 bg-muted/20 p-6 text-sm text-muted">
          No showcase entries match this filter/query yet. Try clearing the search or switching filters.
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
