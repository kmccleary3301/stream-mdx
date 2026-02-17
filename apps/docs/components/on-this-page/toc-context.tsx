"use client";

import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { TocHeading } from "@/lib/toc";

type TocContextValue = {
  headings: TocHeading[];
  setHeadings: (headings: TocHeading[]) => void;
};

const TocHeadingsContext = createContext<TocHeading[]>([]);
const TocSetHeadingsContext = createContext<((headings: TocHeading[]) => void) | null>(null);

export function TocProvider({ children, initialHeadings }: { children: React.ReactNode; initialHeadings?: TocHeading[] }) {
  const [headings, setHeadingsState] = useState<TocHeading[]>(() => initialHeadings ?? []);
  const setHeadings = useCallback((nextHeadings: TocHeading[]) => {
    setHeadingsState((prev) => {
      if (prev.length === nextHeadings.length) {
        const isSame = prev.every((heading, index) => {
          const next = nextHeadings[index];
          return (
            heading.id === next?.id &&
            heading.text === next?.text &&
            heading.level === next?.level &&
            heading.blockId === next?.blockId
          );
        });
        if (isSame) return prev;
      }
      return nextHeadings;
    });
  }, []);
  const headingsValue = useMemo(() => headings, [headings]);
  return (
    <TocSetHeadingsContext.Provider value={setHeadings}>
      <TocHeadingsContext.Provider value={headingsValue}>{children}</TocHeadingsContext.Provider>
    </TocSetHeadingsContext.Provider>
  );
}

export function useTocContext() {
  const headings = useContext(TocHeadingsContext);
  const setHeadings = useContext(TocSetHeadingsContext);
  if (!setHeadings) return null;
  return { headings, setHeadings } satisfies TocContextValue;
}

export function useTocHeadings() {
  return useContext(TocHeadingsContext);
}

export function useSetTocHeadings() {
  return useContext(TocSetHeadingsContext);
}
