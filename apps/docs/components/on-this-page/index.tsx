"use client";

import { cn } from "@/lib/utils";

import { motion } from "framer-motion";
import React, { useCallback, useEffect, useRef, useState } from "react";

type Heading = { id: string; text: string; level: string };

function debounce<F extends (...args: unknown[]) => unknown>(fn: F, waitMs: number) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: Parameters<F>) => {
    if (timeout !== null) clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), waitMs);
  };
  return debounced as (...args: Parameters<F>) => ReturnType<F>;
}

export function TableOfContents() {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [visibleHeadings, setVisibleHeadings] = useState<Set<string>>(new Set());
  const intersectionObserverRef = useRef<IntersectionObserver | null>(null);
  const tocScrollContainerRef = useRef<HTMLDivElement>(null);

  const getHeadings = useCallback((): Heading[] => {
    return Array.from(document.querySelectorAll("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]")).map((heading) => ({
      id: heading.id,
      text: heading.textContent || "",
      level: heading.tagName.toLowerCase(),
    }));
  }, []);

  useEffect(() => {
    const debouncedUpdateHeadings = debounce(() => {
      setHeadings(getHeadings());
    }, 300);

    debouncedUpdateHeadings();

    const contentRoot = document.getElementById("article-content-wrapper") ?? document.body;
    const mutationObserver = new MutationObserver(() => {
      debouncedUpdateHeadings();
    });

    mutationObserver.observe(contentRoot, { childList: true, subtree: true });

    return () => {
      mutationObserver.disconnect();
    };
  }, [getHeadings]);

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
      className={cn(
        "top-[10rem] right-auto left-[2rem] hidden",
        "xl:top-[6rem] xl:right-[6rem] xl:left-auto xl:block",
        "fixed mt-0 h-auto w-60 justify-start transition",
      )}
      aria-label="Table of contents"
    >
      <div
        ref={tocScrollContainerRef}
        className="no-scrollbar mt-0 flex flex-col gap-0 overflow-y-auto scroll-smooth pr-2"
        style={{ maxHeight: "calc(100vh - 12rem)" }}
      >
        {headings.map((heading) => (
          <div key={heading.id} className="mt-0">
            <button
              id={`toc-item-${heading.id}`}
              type="button"
              onClick={() => scrollToHeading(heading.id)}
              className={cn({
                "mt-0 ml-2 w-full border-l border-l-gray-4 py-1 text-left text-muted-old opacity-100 transition ease-in-out hover:opacity-50": true,
                "text-bold text-gray-12": visibleHeadings.has(heading.id),
                "pl-4": heading.level === "h1",
                "pl-6": heading.level === "h2",
                "pl-7": heading.level === "h3",
                "pl-8": heading.level === "h4",
                "pl-9": heading.level === "h5",
                "pl-10": heading.level === "h6",
                "border-l-2 border-l-gray-12": visibleHeadings.has(heading.id),
              })}
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

