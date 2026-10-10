"use client";

import { cn } from "@/lib/utils";

import { ChevronRightIcon } from "@radix-ui/react-icons";
import { Link } from "next-view-transitions";
import { usePathname } from "next/navigation";
import React from "react";

const SEGMENT_WORDS: Record<string, string> = {
  api: "API",
  cli: "CLI",
  css: "CSS",
  devx: "DevX",
  html: "HTML",
  json: "JSON",
  mdx: "MDX",
  tui: "TUI",
};

const MINOR_WORDS = new Set(["and", "or", "of", "in", "the", "to", "for", "vs"]);

function segmentLabel(segment: string): string {
  return segment
    .split("-")
    .map((word, index) => {
      const known = SEGMENT_WORDS[word];
      if (known) return known;
      if (index > 0 && MINOR_WORDS.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

export function Breadcrumb() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter((segment) => segment !== "");

  if (segments.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className={cn("mt-0 mb-4 flex w-full flex-wrap items-center gap-1 align-middle font-normal text-small")}>
      <Link className="text-muted-old hover:text-foreground" href="/">
        Home
      </Link>
      <ChevronRightIcon className="text-muted-old" aria-hidden />
      {segments.map((segment, index) => {
        const href = `/${segments.slice(0, index + 1).join("/")}`;
        const label = segmentLabel(segment);
        const isLast = index === segments.length - 1;

        return (
          <React.Fragment key={href}>
            {isLast ? (
              <span className="text-foreground" aria-current="page">
                {label}
              </span>
            ) : (
              <Link className="text-muted-old hover:text-foreground" href={href}>
                {label}
              </Link>
            )}
            {!isLast && <ChevronRightIcon className="text-muted-old" aria-hidden />}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

