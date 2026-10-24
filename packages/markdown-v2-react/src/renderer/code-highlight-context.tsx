import React from "react";
import type { CodeHighlightRangeRequest } from "../types";
import type { CodeNodeHandle } from "@stream-mdx/core";

export type CodeHighlightRequest = CodeHighlightRangeRequest & { reason?: string };

export type CodeHighlightRequester = (request: CodeHighlightRequest) => void;

export const CodeHighlightRequestContext = React.createContext<CodeHighlightRequester | null>(null);
export interface NativeCodeViewContextValue {
  readonly blockId: string;
  readonly handle: CodeNodeHandle;
}

export const NativeCodeViewContext = React.createContext<NativeCodeViewContextValue | null>(null);

export function useCodeHighlightRequester(): CodeHighlightRequester | null {
  return React.useContext(CodeHighlightRequestContext);
}
