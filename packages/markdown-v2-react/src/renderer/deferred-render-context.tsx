import React from "react";

export type DeferredRenderConfig = {
  rootMargin?: string;
  idleTimeoutMs?: number;
  debounceMs?: number;
};

export const DeferredRenderContext = React.createContext<DeferredRenderConfig | null>(null);
