"use client";

import React, { createContext, useContext, useMemo, useState } from "react";
import type { TocHeading } from "@/lib/toc";

type TocContextValue = {
  headings: TocHeading[];
  setHeadings: (headings: TocHeading[]) => void;
};

const TocContext = createContext<TocContextValue | null>(null);

export function TocProvider({ children, initialHeadings }: { children: React.ReactNode; initialHeadings?: TocHeading[] }) {
  const [headings, setHeadings] = useState<TocHeading[]>(() => initialHeadings ?? []);
  const value = useMemo(() => ({ headings, setHeadings }), [headings]);
  return <TocContext.Provider value={value}>{children}</TocContext.Provider>;
}

export function useTocContext() {
  return useContext(TocContext);
}
