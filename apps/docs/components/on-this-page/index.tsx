"use client";

import { cn } from "@/lib/utils";

import { motion } from "framer-motion";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTocHeadings } from "@/components/on-this-page/toc-context";

type Heading = { id: string; text: string; level: string };
const MAX_TOC_ITEMS = 24;
const TOC_HEADING_SELECTOR = "h2[id], h3[id]";
const TOC_EXCLUDE_PREFIXES = ["appendix", "appendices"];

function debounce<F extends (...args: unknown[]) => unknown>(fn: F, waitMs: number) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: Parameters<F>) => {
    if (timeout !== null) clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), waitMs);
  };
  return debounced as (...args: Parameters<F>) => ReturnType<F>;
}

export function TableOfContents({ className, title = "On this page" }: { className?: string; title?: string }) {
  const [domHeadings, setDomHeadings] = useState<Heading[]>([]);
  const [visibleHeadings, setVisibleHeadings] = useState<Set<string>>(new Set());
  const intersectionObserverRef = useRef<IntersectionObserver | null>(null);
  const tocScrollContainerRef = useRef<HTMLDivElement>(null);
  const contextHeadings = useTocHeadings();
  const contextDerived = useMemo<Heading[]>(
    () =>
      contextHeadings
        .filter((heading) => heading.level >= 2 && heading.level <= 3)
        .filter((heading) => {
          const text = heading.text.toLowerCase();
          return !TOC_EXCLUDE_PREFIXES.some((prefix) => text.startsWith(prefix));
        })
        .map((heading) => ({
          id: heading.id,
          text: heading.text,
          level: `h${heading.level}`,
        }))
        .slice(0, MAX_TOC_ITEMS),
    [contextHeadings],
  );
  // Prefer engine-derived headings when available; otherwise fall back to DOM extraction.
  const useContextHeadings = contextDerived.length > 0;
  const headings = useContextHeadings ? contextDerived : domHeadings;

  const getHeadings = useCallback((): Heading[] => {
    const root = document.getElementById("article-content-wrapper");
    if (!root) return [];

    const seen = new Set<string>();
    return Array.from(root.querySelectorAll(TOC_HEADING_SELECTOR))
      .map((heading) => ({
        id: heading.id,
        text: heading.textContent || "",
        level: heading.tagName.toLowerCase(),
      }))
      .filter((heading) => heading.id.trim().length > 0 && heading.text.trim().length > 0)
      .filter((heading) => {
        const text = heading.text.toLowerCase();
        return !TOC_EXCLUDE_PREFIXES.some((prefix) => text.startsWith(prefix));
      })
      .filter((heading) => {
        if (seen.has(heading.id)) return false;
        seen.add(heading.id);
        return true;
      })
      .slice(0, MAX_TOC_ITEMS);
  }, []);

  useEffect(() => {
    // In docs pages we should always provide engine-derived headings via context.
    // Keep the DOM-derived fallback only for pages that don't wire TocProvider.
    if (useContextHeadings) return;
    const areHeadingsEqual = (a: Heading[], b: Heading[]) => {
      if (a.length !== b.length) return false;
      return a.every((heading, index) => {
        const next = b[index];
        return heading.id === next.id && heading.text === next.text && heading.level === next.level;
      });
    };
    const debouncedUpdateHeadings = debounce(() => {
      setDomHeadings((prev) => {
        const next = getHeadings();
        return areHeadingsEqual(prev, next) ? prev : next;
      });
    }, 300);

    debouncedUpdateHeadings();

    const contentRoot = document.getElementById("article-content-wrapper");
    if (!contentRoot) return;
    const mutationObserver = new MutationObserver(() => {
      debouncedUpdateHeadings();
    });

    mutationObserver.observe(contentRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ["id"] });

    return () => {
      mutationObserver.disconnect();
    };
  }, [getHeadings, useContextHeadings]);

  useEffect(() => {
    if (intersectionObserverRef.current) {
      intersectionObserverRef.current.disconnect();
    }

    const observerOptions: IntersectionObserverInit = { root: null, threshold: 0.1 };

    const handleIntersection = (entries: IntersectionObserverEntry[]) => {
      setVisibleHeadings((prevVisible) => {
        const nextVisible = new Set(prevVisible);
        let changed = false;
        for (const entry of entries) {
          const id = entry.target.id;
          if (!id) continue;
          if (entry.isIntersecting) {
            if (!nextVisible.has(id)) {
              nextVisible.add(id);
              changed = true;
            }
          } else {
            if (nextVisible.has(id)) {
              nextVisible.delete(id);
              changed = true;
            }
          }
        }
        return changed ? nextVisible : prevVisible;
      });
    };

    const observer = new IntersectionObserver(handleIntersection, observerOptions);
    intersectionObserverRef.current = observer;

    for (const heading of headings) {
      const element = document.getElementById(heading.id);
      if (element) observer.observe(element);
    }

    return () => {
      intersectionObserverRef.current?.disconnect();
    };
  }, [headings]);

  useEffect(() => {
    if (!tocScrollContainerRef.current || visibleHeadings.size === 0 || headings.length === 0) return;

    let firstActiveTocItemId: string | null = null;
    for (const heading of headings) {
      if (visibleHeadings.has(heading.id)) {
        firstActiveTocItemId = `toc-item-${heading.id}`;
        break;
      }
    }

    if (!firstActiveTocItemId) return;
    const activeButtonElement = document.getElementById(firstActiveTocItemId);
    activeButtonElement?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [visibleHeadings, headings]);

  const scrollToHeading = (id: string) => {
    for (const heading of Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
      heading.setAttribute("data-highlight", "false");
    }

    const element = document.getElementById(id);
    if (!element) return;

    const top = element.offsetTop - 100;
    window.scrollTo({ top, behavior: "smooth" });
    element.setAttribute("data-highlight", "true");
    setTimeout(() => {
      element.setAttribute("data-highlight", "false");
    }, 2000);
  };

  if (headings.length === 0) return null;

  return (
    <motion.nav
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className={cn("flex flex-col gap-2.5 text-[13px] text-foreground/80", className)}
      aria-label="Table of contents"
    >
      {title ? <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-old">{title}</div> : null}
      <div
        ref={tocScrollContainerRef}
        className="no-scrollbar flex flex-col gap-0.5 overflow-y-auto scroll-smooth pr-2"
        style={{ maxHeight: "calc(100vh - 12rem)" }}
      >
        {headings.map((heading) => (
          <div key={heading.id} className="mt-0">
            <button
              id={`toc-item-${heading.id}`}
              type="button"
              onClick={() => scrollToHeading(heading.id)}
              className={cn(
                "w-full rounded-md px-2 py-1 text-left text-[12px] text-muted-old transition hover:text-foreground",
                {
                  "bg-muted/30 text-foreground font-medium": visibleHeadings.has(heading.id),
                  "pl-4": heading.level === "h1",
                  "pl-6": heading.level === "h2",
                  "pl-7": heading.level === "h3",
                  "pl-8": heading.level === "h4",
                  "pl-9": heading.level === "h5",
                  "pl-10": heading.level === "h6",
                },
              )}
              data-active={visibleHeadings.has(heading.id) ? "true" : "false"}
            >
              {heading.text}
            </button>
          </div>
        ))}
      </div>
    </motion.nav>
  );
}
