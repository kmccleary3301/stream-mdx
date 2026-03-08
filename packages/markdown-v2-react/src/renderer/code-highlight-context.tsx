import React from "react";
import type { CodeHighlightRangeRequest } from "../types";

export type CodeHighlightRequest = CodeHighlightRangeRequest & { reason?: string };

export type CodeHighlightRequester = (request: CodeHighlightRequest) => void;

export const CodeHighlightRequestContext = React.createContext<CodeHighlightRequester | null>(null);

export function useCodeHighlightRequester(): CodeHighlightRequester | null {
  return React.useContext(CodeHighlightRequestContext);
}
