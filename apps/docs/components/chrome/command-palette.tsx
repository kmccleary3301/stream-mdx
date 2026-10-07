"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, FileText, Gauge, Search, Sparkles, Workflow } from "lucide-react";
import { Link } from "next-view-transitions";

import { SEARCH_ENTRIES, type SiteLink } from "@/lib/site-map-client";
import { cn } from "@/lib/utils";

function getKindIcon(kind: SiteLink["kind"]) {
  if (kind === "showcase") return Sparkles;
  if (kind === "docs" || kind === "guide" || kind === "article") return FileText;
  if (kind === "internal") return Gauge;
  return Workflow;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return SEARCH_ENTRIES.slice(0, 12);
    return SEARCH_ENTRIES.filter((entry) =>
      `${entry.label} ${entry.summary} ${entry.href}`.toLowerCase().includes(normalized),
    ).slice(0, 12);
  }, [query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
      if (event.key === "Escape") setOpen(false);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 40);
    return () => window.clearTimeout(id);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="hidden items-center gap-2 rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-xs text-muted-old shadow-[0_12px_34px_-28px_rgba(15,23,42,0.55)] backdrop-blur transition hover:border-border hover:text-foreground md:flex"
        onClick={() => setOpen(true)}
        aria-label="Search documentation and surfaces"
      >
        <Search size={14} />
        <span>Search docs...</span>
        <kbd className="ml-1 rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] uppercase">Cmd K</kbd>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[100] flex items-start justify-center bg-background/70 px-4 pt-24 backdrop-blur-md"
          role="presentation"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-2xl overflow-hidden rounded-2xl border border-border/80 bg-background shadow-[0_28px_90px_-52px_rgba(0,0,0,0.72)]"
            role="dialog"
            aria-modal="true"
            aria-label="Search StreamMDX surfaces"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-border/70 px-4 py-3">
              <Search size={16} className="text-muted-old" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-old"
                placeholder="Search docs, guides, showcase, and route surfaces"
              />
              <button
                type="button"
                className="rounded-md border border-border/70 px-2 py-1 text-[11px] uppercase tracking-[0.12em] text-muted-old transition hover:text-foreground"
                onClick={() => setOpen(false)}
              >
                Esc
              </button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto p-3">
              <div className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-old">Recommended</div>
              <div className="grid gap-1" role="list">
                {filtered.map((entry) => {
                  const Icon = getKindIcon(entry.kind);
                  return (
                    <Link
                      key={`${entry.kind}:${entry.href}`}
                      href={entry.href}
                      className="group grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 transition hover:border-border/80 hover:bg-muted/30"
                      onClick={() => {
                        setOpen(false);
                        setQuery("");
                      }}
                    >
                      <span
                        className={cn(
                          "flex h-8 w-8 items-center justify-center rounded-lg border border-border/70 bg-background/70 text-muted-old",
                          entry.kind === "showcase" && "text-yellow-9",
                          entry.kind === "docs" && "text-pink-9",
                          entry.kind === "guide" && "text-yellow-10",
                        )}
                      >
                        <Icon size={14} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-foreground">{entry.label}</span>
                        <span className="block truncate text-xs text-muted-old">{entry.summary}</span>
                      </span>
                      <ArrowRight size={14} className="text-muted-old transition group-hover:translate-x-0.5 group-hover:text-foreground" />
                    </Link>
                  );
                })}
                {filtered.length === 0 ? (
                  <div className="rounded-xl border border-border/70 bg-muted/20 px-3 py-6 text-center text-sm text-muted-old">
                    No matches. Try protocol, benchmarks, styling, or performance.
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
