import type React from "react";

import type { Block, CompiledMdxModule, FormatAnticipationConfig, InlineHtmlDescriptor, InlineNode } from "@stream-mdx/core";
import type { ComponentRegistry } from "./components";

export type GenericComponent = React.ComponentType<any>;

export interface TableElements {
  Table: GenericComponent;
  Thead: GenericComponent;
  Tbody: GenericComponent;
  Tr: GenericComponent;
  Th: GenericComponent;
  Td: GenericComponent;
}

export type HtmlElements = Record<string, GenericComponent>;

export type InlineHtmlRenderer = (
  descriptor: InlineHtmlDescriptor,
  context: {
    key?: React.Key;
    defaultRender: () => React.ReactElement | null;
  },
) => React.ReactElement | null;

export type InlineHtmlRendererMap = Record<string, InlineHtmlRenderer>;

export interface BlockComponents {
  paragraph: React.FC<{ inlines: InlineNode[]; raw?: string; meta?: Record<string, unknown>; children?: React.ReactNode }>;
  heading: React.FC<{ level: 1 | 2 | 3 | 4 | 5 | 6; inlines: InlineNode[]; text?: string; meta?: Record<string, unknown> }>;
  code: React.FC<{
    html: string;
    meta?: Record<string, unknown>;
    lines?: ReadonlyArray<{ id: string; index: number; text: string; html?: string | null }>;
    lang?: string;
    preAttrs?: Record<string, string>;
    codeAttrs?: Record<string, string>;
  }>;
  blockquote: React.FC<{ inlines: InlineNode[]; renderedContent?: React.ReactNode }>;
  list: React.FC<{ ordered: boolean; items: InlineNode[][] }>;
  html: React.FC<{ __trustedHtml: TrustedHTML | string; elements?: Record<string, GenericComponent> }>;
  mdx: React.FC<{
    compiledRef?: { id: string };
    compiledModule?: CompiledMdxModule | null;
    status?: "pending" | "compiled" | "error";
    errorMessage?: string;
  }>;
  table: React.FC<{ header?: InlineNode[][]; rows: InlineNode[][][]; align?: Array<"left" | "center" | "right" | null>; elements?: Partial<TableElements> }>;
  [k: string]: GenericComponent;
}

export type InlineComponents = Record<string, GenericComponent> & {
  text: React.FC<{ text: string }>;
  strong: React.FC<{ children: React.ReactNode }>;
  em: React.FC<{ children: React.ReactNode }>;
  strike?: React.FC<{ children: React.ReactNode }>;
  code: React.FC<{ text: string }>;
  link: React.FC<{ href?: string; title?: string; children: React.ReactNode }>;
  image: React.FC<{ src: string; alt?: string; title?: string }>;
  br: React.FC<Record<string, never>>;
};

export interface RendererConfig {
  themes?: { light: string; dark: string };
  highlight?: {
    browserEngine?: "js" | "wasm";
    serverEngine?: "wasm";
    langs?: string[];
  };
  sanitization?: {
    schemaId?: string;
  };
  mdx?: {
    enabled?: boolean;
    compileEndpoint?: string;
    compileStrategy?: "server" | "worker";
    components?: Record<string, GenericComponent>;
  };
  plugins?: {
    footnotes?: boolean;
    html?: boolean;
    mdx?: boolean;
    tables?: boolean;
    callouts?: boolean;
    math?: boolean;
    formatAnticipation?: FormatAnticipationConfig;
    liveCodeHighlighting?: boolean;
  };
  performance?: {
    frameBudgetMs?: number;
    flushTimeoutMs?: number;
    maxBatchesPerFlush?: number;
    maxLowPriorityBatchesPerFlush?: number;
    lowPriorityFrameBudgetMs?: number;
    urgentQueueThreshold?: number;
    batch?: "rAF" | "microtask" | "timeout";
    historyLimit?: number;
    startupMicrotaskFlushes?: number;
  };
}

export interface RendererStore {
  reset(blocks: Block[]): void;
  getBlocks(): ReadonlyArray<Block>;
  getVersion(): number;
  subscribe(listener: () => void): () => void;
}

export interface Renderer {
  attachWorker(worker: Worker, options?: { skipInit?: boolean }): void;
  append(text: string): void;
  renderStatic(text: string): Promise<Block[]>;
  onUpdate(cb: (blocks: ReadonlyArray<Block>) => void): () => void;
  setBlockComponents(map: Partial<BlockComponents>): void;
  setInlineComponents(map: Partial<InlineComponents>): void;
  setMdxComponents(map: Record<string, GenericComponent>): void;
  getComponentRegistry(): ComponentRegistry;
  getStore(): RendererStore;
}
