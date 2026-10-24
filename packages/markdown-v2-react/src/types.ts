import type React from "react";

import type {
  Block,
  CodeNodeHandle,
  CodeHighlightOutputMode,
  CodeHighlightingMode,
  ContentPolicy,
  FormatAnticipationConfig,
  HtmlOptions,
  InlineHtmlDescriptor,
  InlineNode,
  LazyTokenizationPriority,
  SyntaxExtensionDescriptor,
  TokenLineV1,
} from "@stream-mdx/core";
import type { FinalizeResult } from "@stream-mdx/protocol";
import type { ContentComponentsMap } from "./components/content-components";
import type { TrustedMdxEngine } from "./trusted-mdx-contract";
import type { ComponentRegistry } from "./components";

export type { HtmlOptions, SyntaxRuleSpec, SyntaxExtensionDescriptor, ContainerExtensionSpec, UrlTransform, UrlTransformContext } from "@stream-mdx/core";
export { defaultUrlTransform } from "@stream-mdx/core";
import type {
  TableVirtualizationConfig,
  TableVirtualizationOptions,
} from "./renderer/virtualized-table";
export type { TableVirtualizationConfig, TableVirtualizationOptions };
import type { VirtualizedCodeConfig } from "./renderer/virtualized-code";
export type { VirtualizedCodeConfig };

export type TableDownloadFormat = "csv" | "tsv" | "markdown";
export type TableCopyFormat = "tsv" | "markdown";

export interface CodeControlsConfig {
  copy?: boolean;
  download?: boolean;
}

export interface TableControlsConfig {
  copy?: boolean | TableCopyFormat[];
  download?: boolean | TableDownloadFormat[];
}

export interface MermaidControlsConfig {
  copy?: boolean;
  fullscreen?: boolean;
}

export interface ControlsLabels {
  copy?: string;
  copied?: string;
  copyError?: string;
  download?: string;
  downloadCsv?: string;
  downloadTsv?: string;
  downloadMarkdown?: string;
  copyTsv?: string;
  copyMarkdown?: string;
  copyTable?: string;
  fullscreen?: string;
  exitFullscreen?: string;
  [key: string]: string | undefined;
}

export interface ControlsOptions {
  code?: boolean | CodeControlsConfig;
  table?: boolean | TableControlsConfig;
  mermaid?: boolean | MermaidControlsConfig;
  labels?: ControlsLabels;
}

export type ControlsConfig = boolean | ControlsOptions;

export interface ControlsComponentProps {
  type: "code" | "table" | "mermaid";
  blockId?: string;
  isFinalized?: boolean;
  code?: string;
  language?: string;
  headers?: string[];
  rows?: string[][];
  align?: Array<"left" | "center" | "right" | null>;
  /** Materialize table strings only when a custom control action needs them. */
  getTableData?: () => { headers: string[]; rows: string[][]; align?: Array<"left" | "center" | "right" | null> };
  onCopy?: (format?: "raw" | "tsv" | "markdown") => Promise<boolean> | boolean | void;
  onDownload?: (format?: "code" | "csv" | "tsv" | "markdown") => void;
  labels?: ControlsLabels;
  children?: React.ReactNode;
}

export interface CodeFenceRendererProps {
  code: string;
  language: string;
  meta?: Record<string, unknown>;
  info?: string;
  isFinalized?: boolean;
  blockId?: string;
  renderCode: React.ReactNode;
  /** Host link handler (honors `linkSafety`). Renderers that surface links, such as artifacts, route clicks through it. */
  openLink?: (url: string) => void;
  /** Controls configuration exposed to fence renderers (e.g. copy, download flags) */
  controls?: {
    copy?: boolean;
    download?: boolean;
    fullscreen?: boolean;
  };
  /** Helper to copy the fence raw source code to clipboard */
  copy?: () => Promise<boolean>;
  /** Helper to download the fence source code snippet */
  download?: () => void;
}

export interface CodeFenceRendererConfig {
  component: React.ComponentType<CodeFenceRendererProps>;
  defer?: boolean;
  /** Extra fence languages (case-insensitive) that resolve to this renderer. */
  aliases?: string[];
}

export type CodeFenceRenderer =
  | React.ComponentType<CodeFenceRendererProps>
  | CodeFenceRendererConfig;

export interface ElementFilterDescriptor {
  tagName: string;
  properties: Record<string, unknown>;
  blockType?: string;
}

export interface ElementFilterContext {
  source: "markdown" | "html";
  parentTagName?: string;
}

export type AllowElementFn = (
  element: ElementFilterDescriptor,
  context: ElementFilterContext,
) => boolean;

/** Render-time element filtering, matching react-markdown / Streamdown semantics. */
export interface ElementFilterOptions {
  /** Only these tag names render. Mutually exclusive with `disallowedElements`. */
  allowedElements?: string[];
  /** These tag names never render. Mutually exclusive with `allowedElements`. */
  disallowedElements?: string[];
  /** Final per-element predicate; runs after the allow/deny lists. */
  allowElement?: AllowElementFn;
  /** Render the children of removed elements in place instead of dropping the subtree. */
  unwrapDisallowed?: boolean;
  /** Autolink protocols (e.g. `["mailto"]`) whose bare/angle autolinks render as plain text. Explicit links are unaffected. */
  disableAutolinkProtocols?: string[];
}

export interface MathRendererProps {
  tex: string;
  display?: boolean;
  className?: string;
}

export type MathRenderer =
  | React.ComponentType<MathRendererProps>
  | {
      inline?: React.ComponentType<{ tex: string; className?: string }>;
      display?: React.ComponentType<{ tex: string; className?: string }>;
    };

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
  heading: React.FC<{ level: 1 | 2 | 3 | 4 | 5 | 6; inlines: InlineNode[]; text?: string; meta?: Record<string, unknown>; children?: React.ReactNode }>;
  code: React.FC<{
    html: string;
    meta?: Record<string, unknown>;
    lines?: ReadonlyArray<{ id: string; index: number; text: string; html?: string | null; tokens?: TokenLineV1 | null }>;
    lang?: string;
    preAttrs?: Record<string, string>;
    codeAttrs?: Record<string, string>;
    /** Prepared renderer-owned children, placed once inside the default semantic code element. */
    children?: React.ReactNode;
  }>;
  blockquote: React.FC<{ inlines: InlineNode[]; renderedContent?: React.ReactNode }>;
  list: React.FC<{ ordered: boolean; items: InlineNode[][] }>;
  html: React.FC<{ __trustedHtml: TrustedHTML | string; elements?: Record<string, GenericComponent>; isSanitized?: boolean; literalTagContent?: string[]; children?: React.ReactNode }>;
  mdx: React.FC<{ raw?: string; meta?: Record<string, unknown> }>;
  hr: React.FC<React.HTMLAttributes<HTMLHRElement>>;
  table: React.FC<{ header?: InlineNode[][]; rows: InlineNode[][][]; align?: Array<"left" | "center" | "right" | null>; elements?: Partial<TableElements> }>;
  [k: string]: GenericComponent;
}

/** Props supplied to a headless native code view. */
export interface CodeNodeViewProps {
  readonly handle: CodeNodeHandle;
}

/** Explicit headless code presentation; it replaces, rather than wraps, the native code view. */
export interface CodeNodePresentation {
  readonly view: React.ComponentType<CodeNodeViewProps>;
  readonly wrapper?: never;
}

export type InlineComponents = Record<string, GenericComponent> & {
  text: React.FC<{ text: string }>;
  strong: React.FC<{ children: React.ReactNode }>;
  em: React.FC<{ children: React.ReactNode }>;
  strike?: React.FC<{ children: React.ReactNode }>;
  code: React.FC<{ text: string }>;
  link: React.FC<{ href?: string; title?: string; children: React.ReactNode }>;
  image: React.FC<{ src?: string; alt?: string; title?: string }>;
  br: React.FC<Record<string, never>>;
};

export interface FinalizedBlockRenderProps {
  block: Block;
  element: React.ReactElement;
}

export type BlockRendererOverride = (props: FinalizedBlockRenderProps) => React.ReactNode;

export interface RendererConfig extends ElementFilterOptions {
  themes?: { light: string; dark: string };
  highlight?: {
    browserEngine?: "js" | "wasm";
    serverEngine?: "wasm";
    langs?: string[];
  };
  sanitization?: {
    schemaId?: string;
  };
  contentPolicy?: ContentPolicy;
  contentComponents?: ContentComponentsMap;
  engines?: {
    mdx?: TrustedMdxEngine;
  };
  plugins?: {
    footnotes?: boolean;
    html?: boolean;
    mdx?: boolean;
    tables?: boolean;
    callouts?: boolean;
    math?: boolean;
    formatAnticipation?: FormatAnticipationConfig;
    codeHighlighting?: CodeHighlightingMode;
    outputMode?: CodeHighlightOutputMode;
    liveCodeHighlighting?: boolean;
    liveTokenization?: boolean;
    emitHighlightTokens?: boolean;
    emitDiffBlocks?: boolean;
  };
  codeRenderers?: Record<string, CodeFenceRenderer>;
  mathRenderer?: MathRenderer;
  blockRenderer?: BlockRendererOverride;
  syntax?: SyntaxExtensionDescriptor;
  html?: HtmlOptions;
  urlTransform?: (url: string, attribute: "href" | "src", context: { source: "markdown" | "html" }) => string | null | undefined;
  tableVirtualization?: TableVirtualizationOptions;
  codeVirtualization?: Partial<VirtualizedCodeConfig>;
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
    adaptiveBudgeting?: boolean;
  };
  controls?: ControlsConfig;
  controlsComponent?: React.ComponentType<ControlsComponentProps>;
}

export interface RendererStore {
  reset(blocks: Block[]): void;
  getBlocks(): ReadonlyArray<Block>;
  getVersion(): number;
  subscribe(listener: () => void): () => void;
}

export type CodeHighlightRangeRequest = {
  blockId: string;
  startLine: number;
  endLine: number;
  priority?: LazyTokenizationPriority;
};

export interface Renderer {
  attachWorker(worker: Worker, options?: { skipInit?: boolean }): void;
  /** Resolve after the attached worker supplies its matching initial root, before queued source dispatch. */
  whenInitialized(): Promise<void>;
  finalize(): Promise<FinalizeResult>;
  renderStatic(text: string): Promise<Block[]>;
  onUpdate(cb: (blocks: ReadonlyArray<Block>) => void): () => void;
  setBlockComponents(map: Partial<BlockComponents>): void;
  setInlineComponents(map: Partial<InlineComponents>): void;
  setCodeRenderers(map: Record<string, CodeFenceRenderer>): void;
  setMathRenderer(renderer: MathRenderer): void;
  setTableVirtualization(options: TableVirtualizationOptions): void;
  getComponentRegistry(): ComponentRegistry;
  getStore(): RendererStore;
  requestCodeHighlightRange(request: CodeHighlightRangeRequest): void;
  setControls(controls: ControlsConfig): void;
  setControlsComponent(component?: React.ComponentType<ControlsComponentProps>): void;
}

export type AnimatedAnimationName = "fadeIn" | "blurIn" | "slideUp" | (string & {});

export interface AnimatedOptions {
  animation?: AnimatedAnimationName;
  duration?: number;
  easing?: string;
  sep?: "word" | "char";
  stagger?: number;
  maxBacklogMs?: number;
}

export type AnimatedProp = boolean | AnimatedOptions;
