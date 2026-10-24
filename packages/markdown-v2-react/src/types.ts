import type React from "react";

import type {
  Block,
  CodeNodeHandle,
  TableNodeHandle,
  CodeHighlightOutputMode,
  CodeHighlightingMode,
  ContentPolicy,
  FormatAnticipationConfig,
  HtmlOptions,
  InlineHtmlDescriptor,
  InlineNode,
  LazyTokenizationPriority,
  SyntaxRuleSpec,
} from "@stream-mdx/core";
import type { FinalizeResult } from "@stream-mdx/protocol";
import type { ContentComponentsMap } from "./components/content-components";
import type { TrustedMdxEngine } from "./trusted-mdx-contract";
import type { ComponentRegistry } from "./components";

export type { HtmlOptions, SyntaxRuleSpec, UrlTransform, UrlTransformContext } from "@stream-mdx/core";
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

export type NativeNodeKey =
  | "paragraph"
  | "heading"
  | "code"
  | "blockquote"
  | "list"
  | "list-item"
  | "list-item-ordered"
  | "list-item-unordered"
  | "table"
  | "table-row"
  | "table-cell"
  | "html"
  | "mdx"
  | "hr"
  | "footnotes"
  | "footnote-def"
  | "callout";

export type NodePresentationKey =
  | NativeNodeKey
  | `inline:${string}`
  | `html:${string}`
  | `component:${string}`
  | `extension:${string}`;

export interface NodeChildRange {
  readonly from: number;
  readonly to: number;
}

export interface NodeHandleMetadata {
  readonly id: string;
  readonly type: string;
  readonly generation: number;
  readonly revision: number;
  readonly childCount: number;
  readonly isFinalized: boolean;
}

/** Opaque read-only identity and subscriptions for one node in one document generation. */
export interface NodeHandle {
  readonly id: string;
  readonly type: string;
  readonly generation: number;
  readonly readMetadata: () => NodeHandleMetadata;
  readonly readChildren: (range: NodeChildRange) => readonly NodeHandle[];
  readonly subscribeMetadata: (listener: () => void) => () => void;
  readonly subscribeChildren: (range: NodeChildRange, listener: () => void) => () => void;
}

export interface NodeViewMetadata {
  readonly id: string;
  readonly type: string;
  readonly isFinalized: boolean;
  readonly language?: string;
  readonly lineCount?: number;
  readonly rowCount?: number;
  readonly columnCount?: number;
  readonly align?: ReadonlyArray<"left" | "center" | "right" | null>;
}

export interface NodeViewActions {
  readonly copy: () => Promise<boolean>;
  readonly download: () => void;
}

/** An L1 wrapper receives the already-prepared native view as its children. */
export interface NodeViewProps {
  readonly children: React.ReactNode;
  readonly metadata: NodeViewMetadata;
  readonly actions: NodeViewActions;
  readonly block?: Block;
}

export interface InlineNodeViewProps {
  readonly node: InlineNode;
  /** Prepared native children; math nodes expose their engine-rendered view here. */
  readonly children?: React.ReactNode;
  readonly metadata: NodeViewMetadata;
  readonly actions: NodeViewActions;
}

export interface HtmlNodeViewProps {
  readonly tagName: string;
  /** Sanitized, URL-transformed native attributes. */
  readonly properties: Readonly<Record<string, unknown>>;
  readonly children?: React.ReactNode;
  readonly metadata: NodeViewMetadata;
  readonly actions: NodeViewActions;
}

export type HeadlessNodeViewProps<K extends NodePresentationKey = NodePresentationKey> =
  K extends "code"
    ? { readonly handle: CodeNodeHandle }
    : K extends "table"
      ? { readonly handle: TableNodeHandle }
      : K extends `inline:${string}` | `extension:${string}`
        ? InlineNodeViewProps
        : K extends `html:${string}`
          ? HtmlNodeViewProps
          : { readonly handle: NodeHandle };

export interface PresentationProps {
  readonly className?: string;
  readonly style?: React.CSSProperties;
  readonly title?: string;
  readonly [name: `data-${string}`]: string | number | boolean | undefined;
  readonly [name: `aria-${string}`]: string | number | boolean | undefined;
}

export interface NativeActionSlot {
  readonly actions?: React.ReactNode;
}

type NodePresentationSlots<K extends NodePresentationKey> =
  K extends "code" | "table" ? NativeActionSlot : never;

export type NodePresentation<K extends NodePresentationKey = NodePresentationKey> =
  Readonly<{
    props?: PresentationProps;
    slots?: NodePresentationSlots<K>;
  }> &
  (
    | { readonly wrapper?: React.ComponentType<NodeViewProps>; readonly view?: never }
    | { readonly view: React.ComponentType<HeadlessNodeViewProps<K>>; readonly wrapper?: never }
  );

export type NodePresentations = Partial<{
  [K in NodePresentationKey]: NodePresentation<K>;
}>;

/** Retained only until existing code consumers are migrated to HeadlessNodeViewProps<\"code\">. */
export type CodeNodeViewProps = HeadlessNodeViewProps<"code">;


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
  components?: NodePresentations;
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
  syntax?: SyntaxRuleSpec[];
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
