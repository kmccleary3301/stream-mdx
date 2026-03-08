"use client";

import { cn } from "@/lib/utils";

import { motion } from "framer-motion";
import { usePathname } from "next/navigation";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTocContext } from "@/components/on-this-page/toc-context";

type Heading = { id: string; text: string; level: string };

type TocConfig = {
  maxItems: number;
  includeLevels: number[];
  excludePrefixes: string[];
  excludePatterns: RegExp[];
};

const BASE_EXCLUDE_PREFIXES = ["appendix", "appendices", "table of contents"];
const BASE_EXCLUDE_PATTERNS = [/^gallery example\b/i, /^appendix extra\b/i];

function isHeadingAllowed(rawText: string, config: TocConfig): boolean {
  const text = rawText.trim();
  if (text.length === 0) return false;

  const lower = text.toLowerCase();
  if (config.excludePrefixes.some((prefix) => lower.startsWith(prefix))) return false;
  if (config.excludePatterns.some((pattern) => pattern.test(text))) return false;

  return true;
}

function getTocConfig(pathname: string): TocConfig {
  const normalizedPath = pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;

  if (
    normalizedPath === "/docs/manual" ||
    normalizedPath === "/showcase/stream-mdx-devx-catalog" ||
    normalizedPath === "/docs/public-api"
  ) {
    return {
      maxItems: 14,
      includeLevels: [2],
      excludePrefixes: BASE_EXCLUDE_PREFIXES,
      excludePatterns: BASE_EXCLUDE_PATTERNS,
    };
  }
  return {
    maxItems: 16,
    includeLevels: [2, 3],
    excludePrefixes: BASE_EXCLUDE_PREFIXES,
    excludePatterns: BASE_EXCLUDE_PATTERNS,
  };
}

function debounce<F extends (...args: unknown[]) => unknown>(fn: F, waitMs: number) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: Parameters<F>) => {
    if (timeout !== null) clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), waitMs);
  };
  return debounced as (...args: Parameters<F>) => ReturnType<F>;
}

export function TableOfContents({ className, title = "On this page" }: { className?: string; title?: string }) {
  const pathname = usePathname();
  const tocConfig = useMemo(() => getTocConfig(pathname ?? ""), [pathname]);
  const headingSelector = useMemo(
    () => tocConfig.includeLevels.map((level) => `h${level}[id]`).join(", "),
    [tocConfig.includeLevels],
  );

  const [domHeadings, setDomHeadings] = useState<Heading[]>([]);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const tocScrollContainerRef = useRef<HTMLDivElement>(null);
  const tocContext = useTocContext();
  const contextHeadings = tocContext?.headings ?? [];
  const contextDerived = useMemo<Heading[]>(
    () =>
      contextHeadings
        .filter((heading) => tocConfig.includeLevels.includes(heading.level))
        .filter((heading) => isHeadingAllowed(heading.text, tocConfig))
        .map((heading) => ({
          id: heading.id,
          text: heading.text,
          level: `h${heading.level}`,
        }))
        .slice(0, tocConfig.maxItems),
    [contextHeadings, tocConfig],
  );

  // Prefer engine-derived headings when they exist, but fall back to DOM scanning for pages
  // that mount TocProvider without precomputed headings.
  const useContextHeadings = tocContext !== null && contextDerived.length > 0;
  const headings = useContextHeadings ? contextDerived : domHeadings;

  const getHeadings = useCallback((): Heading[] => {
    const root = document.getElementById("article-content-wrapper");
    if (!root) return [];

    const seen = new Set<string>();
    return Array.from(root.querySelectorAll(headingSelector))
      .map((heading) => ({
        id: heading.id,
        text: heading.textContent || "",
        level: heading.tagName.toLowerCase(),
      }))
      .filter((heading) => heading.id.trim().length > 0 && heading.text.trim().length > 0)
      .filter((heading) => isHeadingAllowed(heading.text, tocConfig))
      .filter((heading) => {
        if (seen.has(heading.id)) return false;
        seen.add(heading.id);
        return true;
      })
      .slice(0, tocConfig.maxItems);
  }, [headingSelector, tocConfig]);

  useEffect(() => {
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

    mutationObserver.observe(contentRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["id"],
    });

    return () => {
      mutationObserver.disconnect();
    };
  }, [getHeadings, useContextHeadings]);

  useEffect(() => {
    if (headings.length === 0) {
      setActiveHeadingId(null);
      return;
    }

    let rafId = 0;

    const getActiveHeading = () => {
      const viewportOffset = 120;
      let nextActive: string | null = headings[0]?.id ?? null;

      for (const heading of headings) {
        const element = document.getElementById(heading.id);
        if (!element) continue;
        const top = element.getBoundingClientRect().top - viewportOffset;
        if (top <= 0) {
          nextActive = heading.id;
          continue;
        }
        break;
      }

      setActiveHeadingId((prev) => (prev === nextActive ? prev : nextActive));
    };

    const onScrollOrResize = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(getActiveHeading);
    };

    getActiveHeading();
    window.addEventListener("scroll", onScrollOrResize, { passive: true });
    window.addEventListener("resize", onScrollOrResize);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener("scroll", onScrollOrResize);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [headings]);

  useEffect(() => {
    if (!tocScrollContainerRef.current || !activeHeadingId) return;
    const activeButtonElement = document.getElementById(`toc-item-${activeHeadingId}`);
    activeButtonElement?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeHeadingId]);

  const scrollToHeading = (id: string) => {
    for (const heading of Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
      heading.setAttribute("data-highlight", "false");
    }

    const element = document.getElementById(id);
    if (!element) return;

    const top = element.offsetTop - 100;
    window.scrollTo({ top, behavior: "smooth" });
    setActiveHeadingId(id);

    element.setAttribute("data-highlight", "true");
    setTimeout(() => {
      element.setAttribute("data-highlight", "false");
    }, 2000);
  };

  if (headings.length === 0) {
    return (
      <div className={cn("text-xs text-muted-old", className)}>
        No section headings
      </div>
    );
  }

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
                  "bg-muted/30 text-foreground font-medium": activeHeadingId === heading.id,
                  "pl-2": heading.level === "h2",
                  "pl-5": heading.level === "h3",
                },
              )}
              data-active={activeHeadingId === heading.id ? "true" : "false"}
            >
              {heading.text}
            </button>
          </div>
        ))}
      </div>
    </motion.nav>
  );
}
