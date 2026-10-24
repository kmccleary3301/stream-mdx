import React from "react";
import type { CodeNodeHandle, TableNodeHandle } from "@stream-mdx/core";
import type { ComponentRegistry } from "../components";
import type { NodeHandle } from "../types";
import type { RendererStore } from "./store";

export type NodeViewHandle = NodeHandle | CodeNodeHandle | TableNodeHandle;

export interface NodeViewRenderContextValue {
  readonly store: RendererStore;
  readonly registry: ComponentRegistry;
  readonly blockId: string;
  readonly handle: NodeViewHandle;
  readonly nativeTablePart?: React.ReactNode;
}

export const NodeViewRenderContext = React.createContext<NodeViewRenderContextValue | null>(null);
