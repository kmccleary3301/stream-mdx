"use client";

import { Fragment, createContext, createElement, useContext } from "react";
import type { ReactElement, ReactNode } from "react";

export const TrustedMdxNativeChildrenContext = createContext<ReactNode | undefined>(undefined);

/** A compiler-injected flow-root child slot filled by the worker-owned native renderer. */
export function TrustedMdxNativeChildrenSlot({
  index,
  children,
}: {
  readonly index?: number;
  readonly children?: ReactNode;
}): ReactElement {
  const prepared = useContext(TrustedMdxNativeChildrenContext);
  if (prepared === undefined) {
    throw new Error("A trusted MDX native-children slot has no prepared native owner.");
  }
  if (index !== undefined) {
    if (!Array.isArray(prepared) || prepared[index] === undefined) {
      throw new Error(`A trusted MDX native-child slot has no prepared owner at index ${index}.`);
    }
    return createElement(Fragment, null, prepared[index]);
  }
  return createElement(Fragment, null, children === undefined ? prepared : children);
}
