/// <reference lib="es2024.promise" />
"use client";

import type { CodeHighlightingMode, HtmlTreeNode, PerformanceMetrics, WorkerOut } from "@stream-mdx/core";
import type { RendererMetrics, StreamingMarkdownProps, StreamingSchedulerOptions } from "@stream-mdx/react";
import { createTrustedMdxEngine } from "@stream-mdx/react/trusted-mdx";
import { components as mdxComponents } from "@/mdx-components";
import React, { Profiler, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ElementType } from "react";
import { useSearchParams } from "next/navigation";
import { Streamdown, type LinkSafetyConfig, type PluginConfig } from "streamdown";
import { code, type CodeHighlighterPlugin } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";

import { ComponentRegistry, defineContentComponent, SourceCapacityError, StreamingMarkdown, type AppendResult, type ContentComponentHostProps, type ContentComponentProps, type StreamingMarkdownHandle } from "@stream-mdx/react";

import { configureDemoRegistry, createDemoHtmlElements, createDemoTableElements } from "@/lib/streaming-demo-registry";
import { collectGeneratedFootnoteLabels, collectSemanticDom, renderedCodeSource, type GeneratedFootnoteLabel, type SemanticDomRecords } from "../../../../scripts/perf/semantic-dom";
import { createChunkTrace, semanticSha256 } from "../../../../scripts/perf/chunk-trace";
import { collectCodeReadiness } from "../../../../scripts/perf/code-readiness";
import {
  resolveCampaignObservation,
  type CampaignObservationResult,
  type CampaignScenarioConfig,
} from "../../../../scripts/perf/campaign-portfolio";


const perfMdxEngine = createTrustedMdxEngine({
  components: mdxComponents as Readonly<Record<string, ElementType>>,
});
const perfMdxEngines = { mdx: perfMdxEngine };
const streamdownMath = createMathPlugin({ singleDollarTextMath: true });
const PARITY_LINK_SAFETY = { enabled: false } satisfies LinkSafetyConfig;

class BenchmarkHighlighting {
  pending = 0;
  readonly completed = new Set<string>();
  readonly plugin: CodeHighlighterPlugin = {
    ...code,
    highlight: (options, callback) => {
      const key = JSON.stringify([options.language, options.code]);
      this.pending += 1;
      const result = code.highlight(options, (highlighted) => {
        this.pending -= 1;
        this.completed.add(key);
        callback?.(highlighted);
      });
      if (result) {
        this.pending -= 1;
        this.completed.add(key);
      }
      return result;
    },
  };

  isComplete(root: HTMLElement): boolean {
    if (this.pending > 0) return false;
    return Array.from(root.querySelectorAll<HTMLElement>('[data-streamdown="code-block"]')).every((block) => {
      const body = block.querySelector("code");
      if (!body) return false;
      const source = renderedCodeSource(body).replace(/\n+$/, "");
      return this.completed.has(JSON.stringify([block.dataset.language, source]));
    });
  }
}


export type BenchmarkProfile = "parity" | "rich";

export interface ParityPolicyConfig {
  profile: BenchmarkProfile;
  mdx: boolean;
  callouts: boolean;
  math: {
    singleDollar: boolean;
    output: "htmlAndMathml";
  };
  syntaxHighlighting: {
    code: boolean;
    diff: string;
    mode: string;
  };
  streamdownControls: boolean;
  streamdownAnimation: boolean;
  html: boolean;
  linkSafety: boolean;
  gfm: boolean;
  footnotes: boolean;
  customMarkupOverrides: boolean;
}

export const PARITY_POLICY: ParityPolicyConfig = {
  profile: "parity",
  mdx: false,
  callouts: false,
  math: {
    singleDollar: true,
    output: "htmlAndMathml",
  },
  syntaxHighlighting: {
    code: true,
    diff: "grammar_only",
    mode: "incremental",
  },
  streamdownControls: false,
  streamdownAnimation: false,
  html: true,
  linkSafety: false,
  gfm: true,
  footnotes: true,
  customMarkupOverrides: false,
};

export const RICH_POLICY: ParityPolicyConfig = {
  profile: "rich",
  mdx: true,
  callouts: true,
  math: {
    singleDollar: true,
    output: "htmlAndMathml",
  },
  syntaxHighlighting: {
    code: true,
    diff: "grammar_only",
    mode: "live",
  },
  streamdownControls: true,
  streamdownAnimation: true,
  html: true,
  linkSafety: true,
  gfm: true,
  footnotes: true,
  customMarkupOverrides: true,
};

const DEFAULT_FORMAT_ANTICIPATION = {
  inline: true,
  mathInline: true,
  mathBlock: true,
  html: true,
  mdx: true,
  regex: false,
};

const DEFAULT_FEATURES: NonNullable<StreamingMarkdownProps["features"]> = {
  html: true,
  tables: true,
  math: true,
  mdx: true,
  footnotes: true,
  callouts: true,
  formatAnticipation: DEFAULT_FORMAT_ANTICIPATION,
  codeHighlighting: "incremental",
  liveCodeHighlighting: true,
};

const PARITY_FORMAT_ANTICIPATION = {
  inline: true,
  mathInline: true,
  mathBlock: true,
  html: true,
  mdx: false,
  regex: false,
};

const PARITY_FEATURES: NonNullable<StreamingMarkdownProps["features"]> = {
  html: true,
  tables: true,
  math: true,
  mdx: false,
  callouts: false,
  footnotes: true,
  formatAnticipation: PARITY_FORMAT_ANTICIPATION,
  codeHighlighting: "incremental",
  liveCodeHighlighting: true,
  emitDiffBlocks: false,
};

const P9_T2_FIXTURE_ID = "restricted-native-streaming";
const P9_T2_OPEN_STAGE_MARKER = "P9_T2_OPEN_CARD_STAGE";
const P9_T2_CLOSED_STAGE_MARKER = "P9_T2_CLOSED_CARD_STAGE";
const P9_T2_OPEN_STRONG = "Native bold child: p9-open-native-strong";
const P9_T2_CLOSED_STRONG = "Closed-only native child: p9-closed-native-strong";
const P9_T2_INCOMPLETE_STRONG = "Native bold child: p9-incomplete-native-strong";

type P9CardSourceProps = {
  label: string;
  count: number;
  enabled: boolean;
};

type P9CardHostProps = P9CardSourceProps & ContentComponentHostProps;

function renderP9CardHost(component: "Card" | "ClosedCard", props: P9CardHostProps): JSX.Element {
  const { label, count, enabled, children, ...hostProps } = props;
  return (
    <section
      data-p9-component={component}
      data-label={label}
      data-count={String(count)}
      data-enabled={String(enabled)}
      data-component-status={hostProps["data-component-status"] ?? ""}
      data-diagnostic={hostProps["data-diagnostic"] ?? ""}
    >
      {children}
    </section>
  );
}

const P9CardHost = (props: P9CardHostProps): JSX.Element => renderP9CardHost("Card", props);
const P9ClosedCardHost = (props: P9CardHostProps): JSX.Element => renderP9CardHost("ClosedCard", props);
const validateP9CardProps = (props: ContentComponentProps): props is ContentComponentProps & P9CardSourceProps =>
  typeof props.label === "string" &&
  typeof props.count === "number" &&
  Number.isSafeInteger(props.count) &&
  typeof props.enabled === "boolean" &&
  Object.keys(props).every((key) => key === "label" || key === "count" || key === "enabled");

const P9_RESTRICTED_CONTENT_COMPONENTS = Object.freeze({
  Card: defineContentComponent<P9CardSourceProps>({
    component: P9CardHost,
    validateProps: validateP9CardProps,
  }),
  ClosedCard: defineContentComponent<P9CardSourceProps>({
    component: P9ClosedCardHost,
    validateProps: validateP9CardProps,
    renderWhen: "closed",
  }),
});

type P9T2HostObservation = {
  sourceOffset: number;
  closerOffset: number;
  rendered: boolean;
  label: string | null;
  count: string | null;
  enabled: string | null;
  status: string | null;
  diagnostic: string | null;
  nativeStrongText: string | null;
};

type P9T2BrowserAudit = {
  effects: string[];
  trapAttempts: string[];
  trapsInstalledAfterBoot: boolean;
  trapsInstalledBeforeSource: boolean;
  workerInitializedAtTrapInstall: boolean;
  trapsRestored: boolean;
  sourceOffset: number;
  installTraps?: () => void;
  restoreTraps?: () => void;
};

// Keep the installer in the browser module. Serializing Node-transpiled nested
// functions through Playwright can leave their compiler helpers in the wrong realm.
function installRestrictedSourceTraps(): void {
  const audit = window.__streammdxP9T2Audit;
  if (!audit || typeof window.__streammdxPerfStart !== "function" || window.__streammdxPerfError) {
    throw new Error("Evaluation traps require the booted harness and initialized worker.");
  }
  if (audit.sourceOffset !== 0 || typeof window.__streammdxPerfRunStart === "number") {
    throw new Error("Evaluation traps must be installed before source processing.");
  }
  const attempts: string[] = [];
  const previous: Array<{ target: object; key: PropertyKey; descriptor: PropertyDescriptor }> = [];
  const seen = new Map<object, Set<PropertyKey>>();
  let restored = false;
  const deny = (name: string): never => {
    attempts.push(name);
    throw new Error(`restricted source reached ${name}`);
  };
  const blocker = (name: string) => new Proxy(function blockedEvaluation(): never {
    return deny(name);
  }, {
    apply: () => deny(name),
    construct: () => deny(name),
  });
  const wasSeen = (target: object, key: PropertyKey): boolean => {
    const keys = seen.get(target);
    if (keys?.has(key)) return true;
    const nextKeys = keys ?? new Set<PropertyKey>();
    nextKeys.add(key);
    seen.set(target, nextKeys);
    return false;
  };
  const replaceValue = (target: object, key: PropertyKey, name: string): void => {
    if (wasSeen(target, key)) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor?.configurable) throw new Error(`${name} is not configurable for the evaluation trap.`);
    previous.push({ target, key, descriptor });
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: descriptor.enumerable,
      writable: true,
      value: blocker(name),
    });
  };
  const replaceConstructorAccess = (prototype: object, name: string): void => {
    if (wasSeen(prototype, "constructor")) return;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");
    if (!descriptor?.configurable) throw new Error(`${name} is not configurable for the evaluation trap.`);
    previous.push({ target: prototype, key: "constructor", descriptor });
    Object.defineProperty(prototype, "constructor", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: () => deny(name),
    });
  };
  const functionPrototypes = [
    { name: "Function.prototype.constructor", prototype: window.Function.prototype },
    { name: "AsyncFunction.prototype.constructor", prototype: Object.getPrototypeOf(async function p9Async() {}) },
    { name: "GeneratorFunction.prototype.constructor", prototype: Object.getPrototypeOf(function* p9Generator() {}) },
    { name: "AsyncGeneratorFunction.prototype.constructor", prototype: Object.getPrototypeOf(async function* p9AsyncGenerator() {}) },
  ];
  const restore = (): void => {
    if (restored) return;
    restored = true;
    for (const entry of previous.reverse()) Object.defineProperty(entry.target, entry.key, entry.descriptor);
    audit.trapsRestored = true;
  };
  try {
    replaceValue(window, "Function", "window.Function");
    replaceValue(window, "eval", "window.eval");
    for (const { name, prototype } of functionPrototypes) replaceConstructorAccess(prototype, name);
    audit.trapAttempts = attempts;
    audit.restoreTraps = restore;
    audit.trapsInstalledAfterBoot = true;
    audit.trapsInstalledBeforeSource = true;
    audit.workerInitializedAtTrapInstall = true;
  } catch (error) {
    restore();
    throw error;
  }
}

type P9T2FunctionalObservations = {
  contentPolicyPropOmitted: boolean;
  mdxAdmissionEnabled: boolean;
  worker: {
    initialized: boolean;
    sourceEof: boolean;
    finalized: boolean;
    semanticDrain: boolean;
  };
  partialOpeningHeaderObserved: boolean;
  openCardBeforeCloser: P9T2HostObservation;
  closedCardWithheldBeforeCloser: P9T2HostObservation;
  closedCardAfterCloser: P9T2HostObservation;
  incompleteCardAtEof: P9T2HostObservation;
  authoredSource: Record<string, string | null>;
  noScriptOrIframe: boolean;
  sideEffectTrace: string[];
  evaluationTraps: {
    installedAfterBootBeforeSource: boolean;
    attempts: string[];
    restored: boolean;
  };
};

const P9_T2_AUTHORED_SAMPLES = {
  unknownTag: '<UnknownWidget label="unknown-authored-source" />',
  malformedTag: "<Card 12345>",
  braceExpression: '{globalThis.__streammdxP9T2Effects.push("brace-expression")}',
  attributeExpression: '<Card label={globalThis.__streammdxP9T2Effects.push("attribute-expression")} count={7} enabled />',
  functionExpression: '{Function("return globalThis.__streammdxP9T2Effects.push(\'function-constructor\')")()}',
  evalExpression: '{eval("globalThis.__streammdxP9T2Effects.push(\'eval-call\')")}',
  artifactScript: '<script>globalThis.__streammdxP9T2Effects.push("artifact-script")</script>',
  artifactTag: '<Card label={globalThis.__streammdxP9T2Effects.push("artifact-component")} count={1} enabled />',
  artifactExpression: '{Function("return globalThis.__streammdxP9T2Effects.push(\'artifact-constructor\')")()}',
  htmlArtifactScript: '<script>globalThis.__streammdxP9T2Effects.push("html-artifact-script")</script>',
  htmlArtifactIframe: '<iframe srcdoc="<script>globalThis.__streammdxP9T2Effects.push(\'html-artifact-frame\')</script>"></iframe>',
  htmlArtifactTag: '<Card label={globalThis.__streammdxP9T2Effects.push("html-artifact-component")} count={1} enabled />',
  htmlArtifactExpression: '{eval("globalThis.__streammdxP9T2Effects.push(\'html-artifact-eval\')")}',
};

type P9T2SourceOffsets = {
  openHeaderStart: number;
  openHeaderEnd: number;
  openStageEnd: number;
  openCardCloser: number;
  closedStageEnd: number;
  closedCardCloser: number;
  incompleteCardStart: number;
};

function findP9T2SourceOffsets(source: string): P9T2SourceOffsets {
  const openHeaderStart = source.indexOf('<Card label="open-stage"');
  const openHeaderEnd = source.indexOf(">", openHeaderStart) + 1;
  const openStageMarker = source.indexOf(P9_T2_OPEN_STAGE_MARKER);
  const openCardCloser = source.indexOf("</Card>", openHeaderEnd);
  const closedHeaderStart = source.indexOf('<ClosedCard label="closed-stage"');
  const closedStageMarker = source.indexOf(P9_T2_CLOSED_STAGE_MARKER);
  const closedCardCloser = source.indexOf("</ClosedCard>", closedHeaderStart);
  const incompleteCardStart = source.indexOf('<Card label="eof-incomplete"');
  if (
    openHeaderStart < 0 || openHeaderEnd <= openHeaderStart || openStageMarker < openHeaderEnd ||
    openCardCloser <= openStageMarker || closedHeaderStart <= openCardCloser || closedStageMarker < closedHeaderStart ||
    closedCardCloser <= closedStageMarker || incompleteCardStart <= closedCardCloser
  ) {
    throw new Error("Incomplete measurement: restricted streaming fixture stages or actual closers are missing.");
  }
  return {
    openHeaderStart,
    openHeaderEnd,
    openStageEnd: openStageMarker + P9_T2_OPEN_STAGE_MARKER.length,
    openCardCloser,
    closedStageEnd: closedStageMarker + P9_T2_CLOSED_STAGE_MARKER.length,
    closedCardCloser,
    incompleteCardStart,
  };
}

function traceSplitsRange(trace: readonly { text: string }[], start: number, end: number): boolean {
  let offset = 0;
  for (const chunk of trace) {
    offset += chunk.text.length;
    if (offset > start && offset < end) return true;
  }
  return false;
}

function findP9ComponentTreeNode(
  handle: StreamingMarkdownHandle,
  name: "Card" | "ClosedCard",
  label: string,

): Extract<HtmlTreeNode, { kind: "component" }> | null {
  const visit = (nodes: readonly HtmlTreeNode[], seenBlocks: Set<object>): Extract<HtmlTreeNode, { kind: "component" }> | null => {
    for (const node of nodes) {
      if (node.kind === "component") {
        if (node.name === name && node.props.label === label) return node;
        const nested = visit(node.children, seenBlocks);
        if (nested) return nested;
      } else if (node.kind === "element") {
        const nested = visit(node.children, seenBlocks);
        if (nested) return nested;
      } else if (node.kind === "block" && !seenBlocks.has(node.block)) {
        seenBlocks.add(node.block);
        const nestedTree = node.block.payload.meta?.htmlTree;
        if (Array.isArray(nestedTree)) {
          const nested = visit(nestedTree as HtmlTreeNode[], seenBlocks);
          if (nested) return nested;
        }
      }
    }
    return null;
  };

  const seenBlocks = new Set<object>();
  for (const block of handle.getState().blocks) {
    const tree = block.payload.meta?.htmlTree;
    if (Array.isArray(tree)) {
      const node = visit(tree as HtmlTreeNode[], seenBlocks);
      if (node) return node;
    }
  }
  return null;
}

function traceHasBoundaryInRange(trace: readonly { text: string }[], start: number, end: number): boolean {
  let offset = 0;
  for (const chunk of trace) {
    offset += chunk.text.length;
    if (offset >= start && offset < end) return true;
  }
  return false;
}

function readP9HostObservation(
  root: HTMLElement,
  component: "Card" | "ClosedCard",
  label: string,
  sourceOffset: number,
  closerOffset: number,
  treeNode: Extract<HtmlTreeNode, { kind: "component" }> | null = null,
): P9T2HostObservation {
  const host = Array.from(root.querySelectorAll<HTMLElement>(`[data-p9-component="${component}"]`))
    .find((element) => element.dataset.label === label);
  return {
    sourceOffset,
    closerOffset,
    rendered: host !== undefined,
    label: host?.dataset.label ?? (typeof treeNode?.props.label === "string" ? treeNode.props.label : null),
    count: host?.dataset.count ?? (typeof treeNode?.props.count === "number" ? String(treeNode.props.count) : null),
    enabled: host?.dataset.enabled ?? (typeof treeNode?.props.enabled === "boolean" ? String(treeNode.props.enabled) : null),
    status: host?.dataset.componentStatus ?? treeNode?.status ?? null,
    diagnostic: host?.dataset.diagnostic ?? treeNode?.diagnostic ?? null,
    nativeStrongText: host?.querySelector("strong")?.textContent ?? null,
  };
}


export type LiveSubtreeCounts = {
  elements: number;
  pre: number;
  code: number;
  codeBlocks: number;
  inlineCode: number;
  table: number;
  tr: number;
  li: number;
  math: number;
  katex: number;
  headings: number;
};
export type SemanticContent = {
  rawLength: number;
  normalizedLength: number;
  normalizedTextHash: string;
  preview: string;
  records: SemanticDomRecords;
  generatedFootnoteLabels: GeneratedFootnoteLabel[];
  rawHtml: string;
};

async function collectLiveDomMetrics(root: HTMLElement | null): Promise<{
  subtreeCounts: LiveSubtreeCounts;
  semanticContent: SemanticContent;
}> {
  if (!root) throw new Error("Incomplete measurement: semantic DOM root is missing.");

  const elements = root.querySelectorAll("*").length;
  const pre = root.querySelectorAll("pre").length;
  const code = root.querySelectorAll("code").length;
  const inlineCode = root.querySelectorAll("code:not(pre code):not(pre *)").length;
  const codeBlocks = root.querySelectorAll("pre, .markdown-code-block").length;
  const table = root.querySelectorAll("table").length;
  const tr = root.querySelectorAll("tr").length;
  const li = root.querySelectorAll("li").length;
  const math = root.querySelectorAll("math").length;
  const katex = root.querySelectorAll(".katex").length;
  const headings = root.querySelectorAll("h1,h2,h3,h4,h5,h6").length;

  const records = collectSemanticDom(root);
  const normalizedText = records.text;
  const hash = await semanticSha256(JSON.stringify(records));

  return {
    subtreeCounts: {
      elements,
      pre,
      code,
      codeBlocks,
      inlineCode,
      table,
      tr,
      li,
      math: math > 0 ? math : katex,
      katex,
      headings,
    },
    semanticContent: {
      rawLength: (root.textContent ?? "").length,
      normalizedLength: normalizedText.length,
      normalizedTextHash: hash,
      preview: normalizedText.slice(0, 200),
      records,
      generatedFootnoteLabels: collectGeneratedFootnoteLabels(root),
      rawHtml: root.innerHTML,
    },
  };
}


// The public worker factory leaves ownership with the caller on both runtimes.
class BenchmarkWorker {
  private worker: Worker | null = null;
  finalized = false;
  initialized = false;
  workerBootRequestedAt: number | null = null;
  initializedAt: number | null = null;
  finalizedAt: number | null = null;
  error: Error | null = null;
  readonly performanceMetrics: PerformanceMetrics[] = [];
  dispatchedUnits = 0;
  dispatchedAppendsCount = 0;
  lastDispatchedAt: number | null = null;

  readonly onError = (error: Error): void => {
    this.error = error;
  };

  private readonly onMessage = (event: MessageEvent<WorkerOut>): void => {
    if (event.data.type === "INITIALIZED") {
      this.initialized = true;
      this.initializedAt = performance.now();
    }
    if (event.data.type === "FINALIZED") {
      this.finalized = true;
      this.finalizedAt = performance.now();
    }
    if (event.data.type === "ERROR") this.onError(new Error(event.data.error.message));
    if (event.data.type === "METRICS") this.performanceMetrics.push(event.data.metrics);
  };

  private readonly onWorkerError = (event: ErrorEvent): void => {
    this.onError(new Error(event.message || "Benchmark worker failed."));
  };

  private readonly onMessageError = (): void => {
    this.onError(new Error("Benchmark worker message could not be decoded."));
  };

  readonly create = (): Worker => {
    this.dispose();
    this.finalized = false;
    this.initialized = false;
    this.error = null;
    this.performanceMetrics.length = 0;
    this.dispatchedUnits = 0;
    this.dispatchedAppendsCount = 0;
    this.lastDispatchedAt = null;
    this.workerBootRequestedAt = performance.now();
    this.initializedAt = null;
    this.finalizedAt = null;
    const worker = new Worker(`${BASE_PATH}/workers/markdown-worker.js`, { type: "module", name: "markdown-v2" });
    const originalPostMessage = worker.postMessage.bind(worker);
    worker.postMessage = ((message: unknown, transfer?: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "APPEND" &&
        "text" in message &&
        typeof message.text === "string"
      ) {
        this.dispatchedUnits += message.text.length;
        this.lastDispatchedAt = performance.now();
        this.dispatchedAppendsCount += 1;
      }
      return (originalPostMessage as (msg: unknown, tr?: unknown) => void)(message, transfer);
    }) as typeof worker.postMessage;
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", this.onWorkerError);
    worker.addEventListener("messageerror", this.onMessageError);
    this.worker = worker;
    return worker;
  };

  assertHealthy(): void {
    if (this.error) throw this.error;
    if (!this.worker) throw new Error("Benchmark worker is unavailable.");
  }

  dispose(): void {
    if (!this.worker) return;
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onWorkerError);
    this.worker.removeEventListener("messageerror", this.onMessageError);
    this.worker.terminate();
    this.worker = null;
  }
}

function waitForCompletionStep<T>(step: Promise<T>, deadline: number, signal: AbortSignal, phase: string): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error(`Incomplete measurement: timed out waiting for ${phase}.`);
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => reject(new Error("Benchmark navigation cancelled."));
  const timer = window.setTimeout(() => reject(new Error(`Incomplete measurement: timed out waiting for ${phase}.`)), Math.max(0, remaining));
  signal.addEventListener("abort", abort, { once: true });
  step.then(resolve, reject);
  if (signal.aborted) abort();
  return promise.finally(() => {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  });
}

async function waitForStreamMdxCompletion(
  handle: StreamingMarkdownHandle | null,
  worker: BenchmarkWorker,
  root: HTMLElement | null,
  signal: AbortSignal,
  deadline: number,
  expectedSourceUnits: number,
): Promise<{
  finalizeRequestedAt: number;
  finalizeAckAt: number;
  schedulerDrainedAt: number;
  decorationReadyAt: number;
}> {
  if (!handle || !root) throw new Error("Incomplete measurement: StreamMDX did not mount.");
  worker.assertHealthy();
  worker.finalized = false;
  const finalizeRequestedAt = performance.now();
  const finalizeResult = await waitForCompletionStep(
    handle.finalize(),
    deadline,
    signal,
    "StreamMDX host finalization barrier",
  );
  if (
    finalizeResult.acceptedSourceUnits !== expectedSourceUnits ||
    finalizeResult.committedSourceUnits !== expectedSourceUnits
  ) {
    throw new Error(
      `Incomplete measurement: host finalization covered ${finalizeResult.committedSourceUnits}/${finalizeResult.acceptedSourceUnits} source units; expected ${expectedSourceUnits}.`,
    );
  }
  if (!worker.finalized) {
    throw new Error("Incomplete measurement: host finalization resolved without the observed worker FINALIZED.");
  }
  const finalizeAckAt = worker.finalizedAt ?? performance.now();
  // FINALIZED follows the canonical snapshot, but its patches still need to commit.
  handle.flushPending();
  await waitForCompletionStep(handle.waitForIdle(), deadline, signal, "StreamMDX scheduler idle");
  const schedulerDrainedAt = performance.now();
  let stableCount = 0;
  let lastVersion = handle.getState().rendererVersion;
  let hasMutations = false;
  const observer = new MutationObserver(() => { hasMutations = true; });
  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
  try {
    while (stableCount < 3) {
      hasMutations = false;
      await waitForCompletionStep(nextFrame(), deadline, signal, "StreamMDX final DOM and highlighting");
      worker.assertHealthy();
      const state = handle.getState();
      let allFinalized = state.blocks.length > 0 && state.blocks.every((block) => block.isFinalized);
      let pendingLazyCode = false;
      const pendingNodes = state.blocks.map((block) => block.id);
      const visited = new Set<string>();
      while (pendingNodes.length > 0) {
        const id = pendingNodes.pop();
        if (!id || visited.has(id)) continue;
        visited.add(id);
        const node = state.store.getNode(id);
        if (!node) throw new Error("Incomplete measurement: rendered store node is missing.");
        if (node.block && !node.block.isFinalized) allFinalized = false;
        pendingNodes.push(...state.store.getChildren(id));
        const meta = node.block?.payload.meta ?? node.meta ?? node.props;
        const readiness = collectCodeReadiness(node.type, meta);
        if (!readiness.allFinalized) allFinalized = false;
        if (readiness.pendingLazyCode) pendingLazyCode = true;
      }
      const pendingMath = Array.from(root.querySelectorAll(".math-inline[data-tex],.math-display[data-tex]")).some((element) => !element.querySelector(".katex"));
      if (allFinalized && !pendingLazyCode && !pendingMath && !hasMutations && state.rendererVersion === lastVersion) {
        stableCount += 1;
      } else {
        stableCount = 0;
      }
      lastVersion = state.rendererVersion;
    }
  } finally {
    observer.disconnect();
  }
  const decorationReadyAt = performance.now();
  return {
    finalizeRequestedAt,
    finalizeAckAt,
    schedulerDrainedAt,
    decorationReadyAt,
  };
}

async function waitForStreamdownCompletion(
  root: HTMLElement | null,
  committedRef: React.MutableRefObject<number>,
  expectedLength: number,
  highlighting: BenchmarkHighlighting,
  signal: AbortSignal,
  deadline: number,
): Promise<void> {
  if (!root) throw new Error("Incomplete measurement: Streamdown did not mount.");
  while (committedRef.current < expectedLength) {
    await waitForCompletionStep(nextFrame(), deadline, signal, "Streamdown final React commit");
  }

  let stableFrames = 0;
  let hasMutations = false;
  let observer: MutationObserver | null = null;
  if (root && typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(() => {
      hasMutations = true;
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
  }

  try {
    while (stableFrames < 3) {
      hasMutations = false;
      await waitForCompletionStep(nextFrame(), deadline, signal, "Streamdown highlighting and skeleton-free DOM");
      const hasSkeleton = root.querySelector(".streamdown-code-skeleton") !== null;
      if (!hasMutations && !hasSkeleton && highlighting.isComplete(root)) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
      }
    }
  } finally {
    observer?.disconnect();
  }
}

const DEFAULT_SCHEDULING: StreamingSchedulerOptions = {
  batch: "microtask",
  frameBudgetMs: 10,
  maxBatchesPerFlush: 12,
  lowPriorityFrameBudgetMs: 6,
  maxLowPriorityBatchesPerFlush: 2,
  urgentQueueThreshold: 4,
};

const SCHEDULING_PRESETS: Record<string, StreamingSchedulerOptions> = {
  default: DEFAULT_SCHEDULING,
  smooth: {
    batch: "rAF",
    frameBudgetMs: 6,
    maxBatchesPerFlush: 4,
    lowPriorityFrameBudgetMs: 3,
    maxLowPriorityBatchesPerFlush: 1,
    urgentQueueThreshold: 2,
  },
  aggressive: DEFAULT_SCHEDULING,
};

type ScenarioConfig = {
  id: string;
  label?: string;
  updateIntervalMs: number;
  charRateCps: number;
  maxChunkChars: number;
};

type LongTaskEntry = {
  startTime: number;
  duration: number;
};

type MemorySample = {
  ts: number;
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
};

type ProfilerSample = {
  id: string;
  phase: "mount" | "update" | "nested-update";
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
};

type PatchPerfOpSummary = {
  count: number;
  durationMs: number;
};

type PatchPerfSummary = {
  timestamp: string;
  totalMs: number;
  applyMs: number;
  coalesceMs: number;
  listNormalizeMs: number;
  patches: number;
  coalescedPatches: number;
  touchedCount: number;
  mutatedBlocks: boolean;
  ops: Record<string, PatchPerfOpSummary>;
  setPropsByType?: Record<string, PatchPerfOpSummary>;
  setPropsBySize?: Record<string, PatchPerfOpSummary>;
  setPropsStages?: Record<string, PatchPerfOpSummary>;
};

type PatchPerfTotals = {
  calls: number;
  totalMs: number;
  applyMs: number;
  coalesceMs: number;
  listNormalizeMs: number;
  patches: number;
  coalescedPatches: number;
  ops: Record<string, PatchPerfOpSummary>;
  setPropsByType: Record<string, PatchPerfOpSummary>;
  setPropsBySize: Record<string, PatchPerfOpSummary>;
  setPropsStages: Record<string, PatchPerfOpSummary>;
};

type PerfReport = {
  meta: {
    renderer: "streammdx" | "streamdown";
    rendererVersion: string;
    fixtureId: string;
    scenarioId: string;
    schedulingPreset: string;
    scheduling: StreamingSchedulerOptions;
    profile: BenchmarkProfile;
    policy: ParityPolicyConfig;
    updateIntervalMs: number;
    charRateCps: number;
    maxChunkChars: number;
    fixtureHash: string;
    chunkTraceHash: string;
    chunkCount: number;
    runStart: number;
    runEnd: number;
    runDurationMs: number;
    totalChars: number;
    firstFlushAt: number | null;
    userAgent: string;
    functionalObservations?: P9T2FunctionalObservations;
    liveDom: {
      subtreeCounts: LiveSubtreeCounts;
      semanticContent: SemanticContent;
    };
    campaignObservation?: CampaignObservationResult | null;
    resolvedFeatures?: StreamingMarkdownProps["features"];
  };
  samples: {
    flushes: RendererMetrics[];
    workerPerformance: PerformanceMetrics[];
    patchPerf: {
      totals: PatchPerfTotals | null;
      last: PatchPerfSummary | null;
    };
    longTasks: LongTaskEntry[];
    rafDeltas: number[];
    memory: MemorySample[];
    profiler: ProfilerSample[];
    campaignObservation?: CampaignObservationResult | null;
  };
};

declare global {
  interface Window {
    __STREAMING_DEBUG__?: {
      patchPerf?: boolean;
      worker?: boolean;
      codeLines?: boolean;
    };
    __STREAM_MDX_PATCH_STATS__?: PatchPerfSummary[];
    __STREAM_MDX_PATCH_STATS_LAST__?: PatchPerfSummary;
    __STREAM_MDX_PATCH_STATS_TOTALS__?: PatchPerfTotals;
    __streammdxPerfReport?: PerfReport;
    __streammdxPerfDone?: Promise<void>;
    __streammdxPerfError?: string;
    __streammdxPerfRunStart?: number;
    __streammdxPerfRunEnd?: number;
    __streammdxPerfStart?: () => void;
    __streammdxPerfCollect?: () => void;
    __streammdxP9T2Audit?: P9T2BrowserAudit;
    __streammdxP9T2Effects?: string[];
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHandle(ref: React.RefObject<StreamingMarkdownHandle | null>, signal: AbortSignal): Promise<StreamingMarkdownHandle> {
  const timeoutMs = 30000;
  const start = Date.now();
  while (true) {
    if (signal.aborted) throw new Error("Benchmark navigation cancelled.");
    if (ref.current) return ref.current;
    if (Date.now() - start > timeoutMs) {
      throw new Error("StreamingMarkdown handle did not initialize in time.");
    }
    await nextFrame();
  }
}

function parseNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBoolean(value: string | null): boolean | null {
  if (value === null) return null;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return null;
}

function buildScheduling(presetKey: string, params: URLSearchParams): StreamingSchedulerOptions {
  const base = SCHEDULING_PRESETS[presetKey] ?? DEFAULT_SCHEDULING;
  const batch = params.get("batch") ?? base.batch;
  const adaptiveSwitch = parseBoolean(params.get("adaptiveSwitch"));
  const adaptiveBudgeting = parseBoolean(params.get("adaptiveBudgeting"));
  return {
    ...base,
    batch: batch === "microtask" || batch === "timeout" || batch === "rAF" ? batch : base.batch,
    frameBudgetMs: parseNumber(params.get("frameBudgetMs")) ?? base.frameBudgetMs,
    maxBatchesPerFlush: parseNumber(params.get("maxBatchesPerFlush")) ?? base.maxBatchesPerFlush,
    lowPriorityFrameBudgetMs: parseNumber(params.get("lowPriorityFrameBudgetMs")) ?? base.lowPriorityFrameBudgetMs,
    maxLowPriorityBatchesPerFlush: parseNumber(params.get("maxLowPriorityBatchesPerFlush")) ?? base.maxLowPriorityBatchesPerFlush,
    urgentQueueThreshold: parseNumber(params.get("urgentQueueThreshold")) ?? base.urgentQueueThreshold,
    historyLimit: parseNumber(params.get("historyLimit")) ?? base.historyLimit,
    startupMicrotaskFlushes: parseNumber(params.get("startupMicrotaskFlushes")) ?? base.startupMicrotaskFlushes,
    adaptiveBudgeting: adaptiveBudgeting ?? base.adaptiveBudgeting,
    adaptiveSwitch: adaptiveSwitch ?? base.adaptiveSwitch,
    adaptiveQueueThreshold: parseNumber(params.get("adaptiveQueueThreshold")) ?? base.adaptiveQueueThreshold,
  };
}

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

async function fetchFixture(id: string): Promise<string> {
  const response = await fetch(`${BASE_PATH}/perf/fixtures/${encodeURIComponent(id)}.md`);
  if (!response.ok) throw new Error(`Failed to load fixture ${id}`);
  return response.text();
}

async function fetchScenario(id: string): Promise<ScenarioConfig> {
  const response = await fetch(`${BASE_PATH}/perf/scenarios/${encodeURIComponent(id)}.json`);
  if (!response.ok) throw new Error(`Failed to load scenario ${id}`);
  return response.json() as Promise<ScenarioConfig>;
}

async function waitForWorker(handle: StreamingMarkdownHandle, worker: BenchmarkWorker, signal: AbortSignal): Promise<void> {
  const timeoutMs = 30000;
  const start = Date.now();
  while (true) {
    if (signal.aborted) throw new Error("Benchmark navigation cancelled.");
    worker.assertHealthy();
    if (handle.getState().workerReady && worker.initialized) return;
    if (Date.now() - start > timeoutMs) throw new Error("Worker did not initialize in time.");
    await nextFrame();
  }
}

export function PerfHarness(): JSX.Element {
  const searchParams = useSearchParams();
  const observationParam = searchParams.get("observation");
  const fixtureParam = searchParams.get("fixture");
  const campaignDef = useMemo(
    () => resolveCampaignObservation(observationParam) || resolveCampaignObservation(fixtureParam),
    [observationParam, fixtureParam],
  );
  const renderer = (searchParams.get("renderer") ?? "streammdx") as "streammdx" | "streamdown";
  const profile = (searchParams.get("profile") ?? "parity") as BenchmarkProfile;
  const fixtureId = campaignDef ? campaignDef.id : (searchParams.get("fixture") ?? "naive-bayes");
  const restrictedNativeFixture = fixtureId === P9_T2_FIXTURE_ID;
  const scenarioId = campaignDef ? campaignDef.scenario.id : (searchParams.get("scenario") ?? "S2_typical");
  const schedulingPreset = searchParams.get("scheduling") ?? "aggressive";
  const requestedCodeHighlighting = (searchParams.get("codeHighlighting") as CodeHighlightingMode) || "incremental";
  const parityFeatures = useMemo<NonNullable<StreamingMarkdownProps["features"]>>(
    () => restrictedNativeFixture
      ? {
          ...PARITY_FEATURES,
          mdx: true,
          formatAnticipation: { ...PARITY_FORMAT_ANTICIPATION, mdx: true },
        }
      : PARITY_FEATURES,
    [restrictedNativeFixture],
  );
  const contentComponents = restrictedNativeFixture ? P9_RESTRICTED_CONTENT_COMPONENTS : undefined;
  const resolvedFeatures: NonNullable<StreamingMarkdownProps["features"]> = useMemo(() => {
    const base = profile === "parity" ? parityFeatures : DEFAULT_FEATURES;
    return {
      ...base,
      codeHighlighting: requestedCodeHighlighting,
    };
  }, [profile, parityFeatures, requestedCodeHighlighting]);
  const policy = useMemo(() => {
    const base = profile === "rich" ? RICH_POLICY : PARITY_POLICY;
    return {
      ...base,
      ...(restrictedNativeFixture && profile === "parity" ? { mdx: true } : {}),
      syntaxHighlighting: {
        ...base.syntaxHighlighting,
        mode: requestedCodeHighlighting,
      },
    };
  }, [profile, restrictedNativeFixture, requestedCodeHighlighting]);
  const [isColdStarted, setIsColdStarted] = useState(!campaignDef?.isCold);
  const profilerEnabled = parseBoolean(searchParams.get("profiler")) ?? false;
  const patchPerfEnabled = parseBoolean(searchParams.get("patchPerf")) ?? false;
  const queryKey = searchParams.toString();
  const scheduling = useMemo(() => buildScheduling(schedulingPreset, new URLSearchParams(queryKey)), [schedulingPreset, queryKey]);
  const benchmarkWorker = useMemo(() => new BenchmarkWorker(), [queryKey]);
  const highlighting = useMemo(() => new BenchmarkHighlighting(), [queryKey]);
  const streamdownPlugins = useMemo(() => ({ code: highlighting.plugin, math: streamdownMath }), [highlighting]);
  const rendererVersion = searchParams.get("rendererVersion") ?? (renderer === "streamdown" ? "2.7.0" : "streammdx (version not supplied)");
  const [streamdownText, setStreamdownText] = useState("");
  const [streamdownIsAnimating, setStreamdownIsAnimating] = useState(false);
  const streamdownCommittedRef = useRef(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<StreamingMarkdownHandle | null>(null);
  const runTokenRef = useRef(0);

  const flushesRef = useRef<RendererMetrics[]>([]);
  const firstFlushAtRef = useRef<number | null>(null);
  const firstAuthoredTextAtRef = useRef<number | null>(null);
  const firstSemanticCommitAtRef = useRef<number | null>(null);
  const firstAppendAtRef = useRef<number | null>(null);
  const longTasksRef = useRef<LongTaskEntry[]>([]);
  const rafDeltasRef = useRef<number[]>([]);
  const memorySamplesRef = useRef<MemorySample[]>([]);
  const profilerSamplesRef = useRef<ProfilerSample[]>([]);
  const rafActiveRef = useRef(false);
  const memoryTimerRef = useRef<number | null>(null);
  const observerRef = useRef<PerformanceObserver | null>(null);

  const tableElements = useMemo(() => createDemoTableElements(), []);
  const htmlElements = useMemo(() => createDemoHtmlElements(), []);

  const registry = useMemo(() => {
    const next = new ComponentRegistry();
    configureDemoRegistry({
      registry: next,
      tableElements,
      htmlElements,
      showCodeMeta: false,
    });
    return next;
  }, [tableElements, htmlElements]);

  const onMetrics = useCallback((metrics: RendererMetrics) => {
    flushesRef.current.push(metrics);
    if (
      firstSemanticCommitAtRef.current === null
      && metrics.flush.batches.some((batch) => batch.kind === "semantic" && batch.appliedPatchCount > 0)
    ) {
      firstSemanticCommitAtRef.current = performance.now();
    }
  }, []);
  const onStreamdownCommit = useCallback((textLength: number) => {
    streamdownCommittedRef.current = textLength;
  }, []);


  const onProfile = useCallback(
    (
      id: string,
      phase: "mount" | "update" | "nested-update",
      actualDuration: number,
      baseDuration: number,
      startTime: number,
      commitTime: number,
    ) => {
      if (!profilerEnabled) return;
      profilerSamplesRef.current.push({
        id,
        phase,
        actualDuration,
        baseDuration,
        startTime,
        commitTime,
      });
    },
    [profilerEnabled],
  );


  useEffect(() => {
    let cancelled = false;
    const token = (runTokenRef.current += 1);
    const controller = new AbortController();
    let firstContentObserver: MutationObserver | null = null;
    const { promise: done, resolve: resolveDone } = Promise.withResolvers<void>();
    const previousDebug = typeof window !== "undefined" ? window.__STREAMING_DEBUG__ : undefined;
    const previousPatchPerfDescriptor = previousDebug ? Object.getOwnPropertyDescriptor(previousDebug, "patchPerf") : undefined;
    const patchPerfDebug = { ...(previousDebug ?? {}), patchPerf: patchPerfEnabled };
    const previousP9EffectsDescriptor = restrictedNativeFixture
      ? Object.getOwnPropertyDescriptor(window, "__streammdxP9T2Effects")
      : undefined;
    const p9Audit: P9T2BrowserAudit | null = restrictedNativeFixture
      ? {
          effects: [],
          trapAttempts: [],
          trapsInstalledAfterBoot: false,
          trapsInstalledBeforeSource: false,
          workerInitializedAtTrapInstall: false,
          trapsRestored: false,
          sourceOffset: 0,
        }
      : null;
    if (p9Audit) {
      window.__streammdxP9T2Audit = p9Audit;
      p9Audit.installTraps = installRestrictedSourceTraps;
      Object.defineProperty(window, "__streammdxP9T2Effects", {
        configurable: true,
        writable: true,
        value: p9Audit.effects,
      });
    }

    if (typeof window !== "undefined") {
      window.__STREAMING_DEBUG__ = patchPerfDebug;
      window.__STREAM_MDX_PATCH_STATS__ = [];
      window.__STREAM_MDX_PATCH_STATS_LAST__ = undefined;
      window.__STREAM_MDX_PATCH_STATS_TOTALS__ = undefined;
      window.__streammdxPerfReport = undefined;
      window.__streammdxPerfError = undefined;
      window.__streammdxPerfRunStart = undefined;
      window.__streammdxPerfRunEnd = undefined;
      window.__streammdxPerfStart = undefined;
      window.__streammdxPerfCollect = undefined;
      window.__streammdxPerfDone = done;
    }

    const startLongTasks = () => {
      longTasksRef.current = [];
      if (!("PerformanceObserver" in window)) return;
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasksRef.current.push({ startTime: entry.startTime, duration: entry.duration });
          }
        });
        observer.observe({ type: "longtask", buffered: true });
        observerRef.current = observer;
      } catch {
        observerRef.current = null;
      }
    };

    const stopLongTasks = () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };

    const startRaf = () => {
      rafDeltasRef.current = [];
      rafActiveRef.current = true;
      let last = performance.now();
      const tick = (now: number) => {
        if (!rafActiveRef.current) return;
        rafDeltasRef.current.push(Math.max(0, now - last));
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };

    const stopRaf = () => {
      rafActiveRef.current = false;
    };

    const startMemory = () => {
      memorySamplesRef.current = [];
      if (!("memory" in performance)) return;
      if (memoryTimerRef.current !== null) {
        clearInterval(memoryTimerRef.current);
      }
      memoryTimerRef.current = window.setInterval(() => {
        const mem = (performance as Performance & { memory?: MemorySample }).memory;
        if (!mem) return;
        memorySamplesRef.current.push({
          ts: performance.now(),
          usedJSHeapSize: mem.usedJSHeapSize,
          totalJSHeapSize: mem.totalJSHeapSize,
          jsHeapSizeLimit: mem.jsHeapSizeLimit,
        });
      }, 250);
    };

    const stopMemory = () => {
      if (memoryTimerRef.current !== null) {
        clearInterval(memoryTimerRef.current);
        memoryTimerRef.current = null;
      }
    };

    const run = async () => {
      try {
        if (restrictedNativeFixture && (renderer !== "streammdx" || profile !== "parity")) {
          throw new Error("The restricted native streaming fixture requires renderer=streammdx and profile=parity.");
        }
        let p9Offsets: P9T2SourceOffsets | null = null;
        let p9PartialOpeningHeaderObserved = false;
        let p9SourceOffset = 0;
        let p9SourceEof = false;
        let p9SemanticDrain = false;
        let p9OpenCardBeforeCloser: P9T2HostObservation | null = null;
        let p9ClosedCardWithheldBeforeCloser: P9T2HostObservation | null = null;
        let p9ObservationError: Error | null = null;

        let fixture: string;
        let scenario: ScenarioConfig | CampaignScenarioConfig;
        let trace: Array<{ atMs: number; text: string }>;
        if (campaignDef) {
          fixture = campaignDef.getFixture();
          scenario = campaignDef.scenario;
          trace = campaignDef.getTrace();
        } else {
          fixture = await fetchFixture(fixtureId);
          scenario = await fetchScenario(scenarioId);
          trace = createChunkTrace(fixture, scenario);
        }
        if (restrictedNativeFixture) {
          p9Offsets = findP9T2SourceOffsets(fixture);
          p9PartialOpeningHeaderObserved = traceSplitsRange(trace, p9Offsets.openHeaderStart, p9Offsets.openHeaderEnd);
          if (!p9PartialOpeningHeaderObserved) {
            throw new Error("Incomplete measurement: the source producer did not split the opening Card header.");
          }
          if (
            !traceHasBoundaryInRange(trace, p9Offsets.openStageEnd, p9Offsets.openCardCloser) ||
            !traceHasBoundaryInRange(trace, p9Offsets.closedStageEnd, p9Offsets.closedCardCloser)
          ) {
            throw new Error("Incomplete measurement: the selected source trace cannot expose both open-component stages.");
          }
        }
        const fixtureHash = campaignDef ? campaignDef.fixtureHash : await semanticSha256(fixture);
        const chunkTraceHash = campaignDef ? campaignDef.traceHash : await semanticSha256(JSON.stringify(trace));
        if (cancelled || token !== runTokenRef.current) return;

        flushesRef.current = [];
        benchmarkWorker.performanceMetrics.length = 0;
        firstFlushAtRef.current = null;
        firstAuthoredTextAtRef.current = null;
        firstSemanticCommitAtRef.current = null;
        firstAppendAtRef.current = null;
        profilerSamplesRef.current = [];

        let streamRequestedAt = performance.now();
        const isColdRun = Boolean(campaignDef?.isCold);
        const readinessDeadline = performance.now() + 30000;

        if (renderer === "streammdx") {
          if (!isColdRun) {
            const handle = await waitForCompletionStep(waitForHandle(handleRef, controller.signal), readinessDeadline, controller.signal, "StreamMDX handle");
            await waitForCompletionStep(waitForWorker(handle, benchmarkWorker, controller.signal), readinessDeadline, controller.signal, "worker initialization");
            benchmarkWorker.assertHealthy();
            handle.resume();
            await nextFrame();
          }
        } else {
          setStreamdownText("");
          setStreamdownIsAnimating(profile === "rich");
          streamdownCommittedRef.current = 0;
          await nextFrame();
        }
        const observeP9StreamingState = (): void => {
          if (!restrictedNativeFixture || !p9Offsets || p9ObservationError) return;
          const handle = handleRef.current;
          const root = rootRef.current;
          if (!handle || !root) return;

          if (p9OpenCardBeforeCloser === null && p9SourceOffset >= p9Offsets.openStageEnd) {
            if (p9SourceOffset >= p9Offsets.openCardCloser) {
              p9ObservationError = new Error("Incomplete measurement: open Card host was not observed before its closer.");
              return;
            }
            const treeNode = findP9ComponentTreeNode(handle, "Card", "open-stage");
            const observation = readP9HostObservation(root, "Card", "open-stage", p9SourceOffset, p9Offsets.openCardCloser, treeNode);
            if (
              treeNode?.status === "open" &&
              observation.rendered &&
              observation.status === "open" &&
              observation.count === "17" &&
              observation.enabled === "true" &&
              observation.nativeStrongText === P9_T2_OPEN_STRONG
            ) {
              p9OpenCardBeforeCloser = observation;
            }
          }

          if (p9ClosedCardWithheldBeforeCloser === null && p9SourceOffset >= p9Offsets.closedStageEnd) {
            if (p9SourceOffset >= p9Offsets.closedCardCloser) {
              p9ObservationError = new Error("Incomplete measurement: ClosedCard withholding was not observed before its closer.");
              return;
            }
            const treeNode = findP9ComponentTreeNode(handle, "ClosedCard", "closed-stage");
            const observation = readP9HostObservation(root, "ClosedCard", "closed-stage", p9SourceOffset, p9Offsets.closedCardCloser, treeNode);
            if (
              treeNode?.status === "open" &&
              !observation.rendered &&
              observation.count === "23" &&
              observation.enabled === "true"
            ) {
              p9ClosedCardWithheldBeforeCloser = observation;
            }
          }
        };
        if (cancelled || token !== runTokenRef.current) return;

        const cdpControlled = new URLSearchParams(window.location.search).get("cdp") === "1";
        if (cdpControlled) {
          const { promise, resolve } = Promise.withResolvers<void>();
          window.__streammdxPerfStart = resolve;
          await waitForCompletionStep(promise, readinessDeadline, controller.signal, "CDP start acknowledgment");
          window.__streammdxPerfStart = undefined;
        }

        startLongTasks();
        startRaf();
        startMemory();

        let runStart = performance.now();
        streamRequestedAt = runStart;

        if (renderer === "streammdx" && isColdRun) {
          setIsColdStarted(true);
          const handle = await waitForCompletionStep(waitForHandle(handleRef, controller.signal), readinessDeadline, controller.signal, "StreamMDX handle (cold)");
          await waitForCompletionStep(waitForWorker(handle, benchmarkWorker, controller.signal), readinessDeadline, controller.signal, "worker initialization (cold)");
          benchmarkWorker.assertHealthy();
          handle.resume();
          await nextFrame();
        }

        window.__streammdxPerfRunStart = isColdRun ? streamRequestedAt : runStart;
        const effectiveRunStart = isColdRun ? streamRequestedAt : runStart;
        const observationDeadline = effectiveRunStart + 60000;

        const observeFirstContent = () => {
          const root = rootRef.current;
          if (!root || firstFlushAtRef.current !== null) return;
          if (isColdRun || campaignDef?.area === "huge-code") {
            const codeElements = root.querySelectorAll("pre code, code");
            for (const el of Array.from(codeElements)) {
              if (el.closest("[data-control],script,style,[data-streamdown='code-block-header'],[data-streamdown$='-button']")) {
                continue;
              }
              const text = el.textContent ?? "";
              const trimmed = text.trim();
              if (!trimmed) continue;
              if (trimmed === "typescript" || trimmed === "ts" || trimmed === "javascript" || trimmed === "js") continue;
              if (trimmed === "copy" || trimmed === "streaming" || trimmed === "ready") continue;
              if (campaignDef?.expectedAuthoredSnippet && !text.includes(campaignDef.expectedAuthoredSnippet)) continue;
              const now = performance.now();
              firstFlushAtRef.current = now;
              firstAuthoredTextAtRef.current = now;
              firstContentObserver?.disconnect();
              firstContentObserver = null;
              return;
            }
          } else {
            const textNodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            while (textNodes.nextNode()) {
              const node = textNodes.currentNode;
              const text = node.textContent ?? "";
              if (
                text.trim() &&
                !node.parentElement?.closest("[data-control],script,style,[data-streamdown='code-block-header'],[data-streamdown$='-button']")
              ) {
                const now = performance.now();
                firstFlushAtRef.current = now;
                firstAuthoredTextAtRef.current = now;
                firstContentObserver?.disconnect();
                firstContentObserver = null;
                return;
              }
            }
          }
        };

        firstContentObserver = new MutationObserver(observeFirstContent);
        if (!rootRef.current) throw new Error("Incomplete measurement: content root did not mount.");
        firstContentObserver.observe(rootRef.current, { childList: true, subtree: true, characterData: true });

        let fenceClosedAt: number | null = null;
        const hasCodeFence = fixture.includes("```");
        const closingFenceIndex = hasCodeFence ? fixture.lastIndexOf("```") : -1;
        let accumulatedChars = 0;
        let acceptedUnitsCount = 0;
        let accumulated = "";

        const baseTime = performance.now();
        let lastOfferAtMs = baseTime;
        let lastTraceAtMs = 0;
        let scheduleDelaySum = 0;
        let maxScheduleDelayMs = 0;
        let delayedTicksCount = 0;
        const nominalTotalMs = trace.length > 0 ? trace[trace.length - 1].atMs : 0;

        let traceIndex = 0;
        for (const chunk of trace) {
          if (cancelled || token !== runTokenRef.current) return;
          if (performance.now() >= observationDeadline) {
            throw new Error("Incomplete measurement: observation deadline exceeded during chunk playback.");
          }
          if (renderer === "streammdx") benchmarkWorker.assertHealthy();
          const targetTime = baseTime + chunk.atMs;
          const earliestOfferTime = lastOfferAtMs + Math.max(0, chunk.atMs - lastTraceAtMs);
          const waitTime = Math.max(targetTime, earliestOfferTime) - performance.now();
          if (waitTime > 0) {
            await sleep(waitTime);
          }
          if (cancelled || token !== runTokenRef.current) return;
          const offerTime = performance.now();
          lastOfferAtMs = offerTime;
          lastTraceAtMs = chunk.atMs;
          const delayMs = Math.max(0, offerTime - targetTime);
          scheduleDelaySum += delayMs;
          if (delayMs > maxScheduleDelayMs) maxScheduleDelayMs = delayMs;
          if (delayMs > 2) delayedTicksCount += 1;

          if (firstAppendAtRef.current === null) {
            firstAppendAtRef.current = offerTime;
          }
          accumulatedChars += chunk.text.length;
          if (hasCodeFence && fenceClosedAt === null && closingFenceIndex >= 0 && accumulatedChars >= closingFenceIndex + 3) {
            fenceClosedAt = offerTime;
          }
          if (restrictedNativeFixture) {
            observeP9StreamingState();
            if (p9ObservationError) throw p9ObservationError;
          }

          if (renderer === "streammdx") {
            const handle = handleRef.current;
            if (!handle) throw new Error("Incomplete measurement: StreamMDX handle missing during append.");
            let chunkOffset = 0;
            while (chunkOffset < chunk.text.length) {
              const sourcePart = chunk.text.slice(chunkOffset, chunkOffset + 65_536);
              let admission: AppendResult;
              for (;;) {
                try {
                  admission = handle.append(sourcePart);
                  break;
                } catch (error) {
                  if (!(error instanceof SourceCapacityError) || !error.retryable) throw error;
                  await waitForCompletionStep(
                    handle.waitForCapacity({ units: sourcePart.length, signal: controller.signal }),
                    observationDeadline,
                    controller.signal,
                    "source admission capacity",
                  );
                }
              }
              if (admission.acceptedSourceUnits !== acceptedUnitsCount + sourcePart.length) {
                throw new Error(
                  `Incomplete measurement: host admitted ${admission.acceptedSourceUnits} source units; expected ${acceptedUnitsCount + sourcePart.length}.`,
                );
              }
              acceptedUnitsCount += sourcePart.length;
              chunkOffset += sourcePart.length;
              const nextUnits = chunkOffset < chunk.text.length
                ? Math.min(65_536, chunk.text.length - chunkOffset)
                : Math.min(65_536, trace[traceIndex + 1]?.text.length ?? 0);
              if (admission.shouldPause && nextUnits > 0) {
                await waitForCompletionStep(
                  handle.waitForCapacity({ units: nextUnits, signal: controller.signal }),
                  observationDeadline,
                  controller.signal,
                  "source admission capacity",
                );
              }
            }
            traceIndex += 1;
            if (restrictedNativeFixture) {
              p9SourceOffset += chunk.text.length;
              if (p9Audit) p9Audit.sourceOffset = p9SourceOffset;
              observeP9StreamingState();
              if (p9ObservationError) throw p9ObservationError;
            }
          } else {
            accumulated += chunk.text;
            setStreamdownText(accumulated);
            acceptedUnitsCount += chunk.text.length;
          }
        }
        if (restrictedNativeFixture) {
          observeP9StreamingState();
          if (p9ObservationError) throw p9ObservationError;
          p9SourceEof = p9Audit?.sourceOffset === fixture.length && p9SourceOffset === fixture.length;
          if (!p9SourceEof || !p9OpenCardBeforeCloser || !p9ClosedCardWithheldBeforeCloser) {
            throw new Error("Incomplete measurement: restricted source EOF or pre-closer component observations are missing.");
          }
        }

        let streamMdxTimings: {
          finalizeRequestedAt: number;
          finalizeAckAt: number;
          schedulerDrainedAt: number;
          decorationReadyAt: number;
        } | null = null;

        if (renderer === "streammdx") {
          streamMdxTimings = await waitForStreamMdxCompletion(
            handleRef.current,
            benchmarkWorker,
            rootRef.current,
            controller.signal,
            observationDeadline,
            acceptedUnitsCount,
          );
        } else {
          await waitForStreamdownCompletion(
            rootRef.current,
            streamdownCommittedRef,
            fixture.length,
            highlighting,
            controller.signal,
            observationDeadline,
          );
          setStreamdownIsAnimating(false);
        }
        if (cancelled || token !== runTokenRef.current) return;
        if (firstFlushAtRef.current === null) throw new Error("Incomplete measurement: no post-start committed content observed.");
        let p9FunctionalObservations: P9T2FunctionalObservations | undefined;
        if (restrictedNativeFixture) {
          const finalRoot = rootRef.current;
          const finalHandle = handleRef.current;
          if (!p9Offsets || !p9Audit || !finalRoot || !finalHandle) {
            throw new Error("Incomplete measurement: restricted streaming observations are unavailable.");
          }
          p9SemanticDrain = benchmarkWorker.finalized;
          const closedTreeNode = findP9ComponentTreeNode(finalHandle, "ClosedCard", "closed-stage");
          const incompleteTreeNode = findP9ComponentTreeNode(finalHandle, "Card", "eof-incomplete");
          const closedCardAfterCloser = readP9HostObservation(
            finalRoot,
            "ClosedCard",
            "closed-stage",
            p9SourceOffset,
            p9Offsets.closedCardCloser,
            closedTreeNode,
          );
          const incompleteCardAtEof = readP9HostObservation(
            finalRoot,
            "Card",
            "eof-incomplete",
            p9SourceOffset,
            fixture.length,
            incompleteTreeNode,
          );
          const renderedText = finalRoot.textContent ?? "";
          const renderedCode = Array.from(finalRoot.querySelectorAll("pre code")).map((node) => node.textContent ?? "");
          const authoredSource = Object.fromEntries(
            Object.entries(P9_T2_AUTHORED_SAMPLES).map(([key, sample]) => {
              const inFence = key.startsWith("artifact") || key.startsWith("htmlArtifact");
              const preserved = inFence
                ? renderedCode.some((codeText) => codeText.includes(sample))
                : renderedText.includes(sample);
              return [key, preserved ? sample : null];
            }),
          );
          const noScriptOrIframe = finalRoot.querySelector("script,iframe") === null;
          const trapsInstalled = p9Audit.trapsInstalledAfterBoot &&
            p9Audit.trapsInstalledBeforeSource &&
            p9Audit.workerInitializedAtTrapInstall;
          const sideEffectTrace = [...p9Audit.effects];
          const trapAttempts = [...p9Audit.trapAttempts];
          const evaluationTraps = {
            installedAfterBootBeforeSource: trapsInstalled,
            attempts: trapAttempts,
            restored: p9Audit.trapsRestored,
          };
          p9SemanticDrain = p9SemanticDrain && benchmarkWorker.initialized && p9SourceEof;
          p9FunctionalObservations = {
            contentPolicyPropOmitted: true,
            mdxAdmissionEnabled: parityFeatures.mdx === true && policy.mdx,
            worker: {
              initialized: benchmarkWorker.initialized,
              sourceEof: p9SourceEof,
              finalized: benchmarkWorker.finalized,
              semanticDrain: p9SemanticDrain,
            },
            partialOpeningHeaderObserved: p9PartialOpeningHeaderObserved,
            openCardBeforeCloser: p9OpenCardBeforeCloser!,
            closedCardWithheldBeforeCloser: p9ClosedCardWithheldBeforeCloser!,
            closedCardAfterCloser,
            incompleteCardAtEof,
            authoredSource,
            noScriptOrIframe,
            sideEffectTrace,
            evaluationTraps,
          };
          const requiredAuthoredSamplesPreserved = Object.values(authoredSource).every((sample) => sample !== null);
          if (
            !p9FunctionalObservations.contentPolicyPropOmitted ||
            !p9FunctionalObservations.mdxAdmissionEnabled ||
            !Object.values(p9FunctionalObservations.worker).every(Boolean) ||
            !p9FunctionalObservations.partialOpeningHeaderObserved ||
            p9FunctionalObservations.openCardBeforeCloser.sourceOffset >= p9FunctionalObservations.openCardBeforeCloser.closerOffset ||
            p9FunctionalObservations.openCardBeforeCloser.status !== "open" ||
            p9FunctionalObservations.openCardBeforeCloser.nativeStrongText !== P9_T2_OPEN_STRONG ||
            p9FunctionalObservations.closedCardWithheldBeforeCloser.sourceOffset >= p9FunctionalObservations.closedCardWithheldBeforeCloser.closerOffset ||
            p9FunctionalObservations.closedCardWithheldBeforeCloser.rendered ||
            p9FunctionalObservations.closedCardWithheldBeforeCloser.status !== "open" ||
            !closedCardAfterCloser.rendered ||
            closedCardAfterCloser.sourceOffset <= closedCardAfterCloser.closerOffset ||
            closedCardAfterCloser.status !== "closed" ||
            closedCardAfterCloser.nativeStrongText !== P9_T2_CLOSED_STRONG ||
            !incompleteCardAtEof.rendered ||
            incompleteCardAtEof.status !== "incomplete" ||
            !/Unclosed component tag/.test(incompleteCardAtEof.diagnostic ?? "") ||
            incompleteCardAtEof.nativeStrongText !== P9_T2_INCOMPLETE_STRONG ||
            !requiredAuthoredSamplesPreserved ||
            !noScriptOrIframe ||
            sideEffectTrace.length !== 0 ||
            trapAttempts.length !== 0 ||
            !evaluationTraps.installedAfterBootBeforeSource
          ) {
            throw new Error("Incomplete measurement: restricted streaming functional observations failed.");
          }
        }

        const runEnd = performance.now();
        stopLongTasks();
        stopRaf();
        stopMemory();
        window.__streammdxPerfRunEnd = runEnd;
        if (cdpControlled) {
          const { promise, resolve } = Promise.withResolvers<void>();
          window.__streammdxPerfCollect = resolve;
          await waitForCompletionStep(promise, observationDeadline, controller.signal, "CDP end acknowledgment");
          window.__streammdxPerfCollect = undefined;
        }
        if (p9FunctionalObservations && p9Audit) {
          // The driver restores after runEnd, then acknowledges collection.
          p9FunctionalObservations = {
            ...p9FunctionalObservations,
            sideEffectTrace: [...p9Audit.effects],
            evaluationTraps: {
              ...p9FunctionalObservations.evaluationTraps,
              attempts: [...p9Audit.trapAttempts],
              restored: p9Audit.trapsRestored,
            },
          };
          if (p9FunctionalObservations.sideEffectTrace.length !== 0 ||
            p9FunctionalObservations.evaluationTraps.attempts.length !== 0 ||
            !p9FunctionalObservations.evaluationTraps.restored) {
            throw new Error("Incomplete measurement: restricted evaluation traps did not restore cleanly after content processing.");
          }
        }
        const liveDom = await collectLiveDomMetrics(rootRef.current);
        if (cancelled || token !== runTokenRef.current) return;

        const memSamples = memorySamplesRef.current.map((s) => s.usedJSHeapSize / (1024 * 1024));
        const peakMem = memSamples.length > 0 ? Math.max(...memSamples) : null;
        const storeBlockRawCharsTotal = handleRef.current
          ? handleRef.current.getState().blocks.reduce((acc, b) => acc + (b.payload.raw?.length ?? 0), 0)
          : null;

        const campaignObservation: CampaignObservationResult | null = campaignDef
          ? {
              observationId: campaignDef.id,
              area: campaignDef.area,
              resolvedConfig: {
                renderer,
                profile,
                codeHighlighting: requestedCodeHighlighting,
                scheduling: schedulingPreset,
                isCold: campaignDef.isCold,
                targetUnits: campaignDef.targetUnits,
                decimalSizeLabel: campaignDef.decimalSizeLabel,
                updateIntervalMs: scenario.updateIntervalMs,
                charRateCps: scenario.charRateCps,
                maxChunkChars: scenario.maxChunkChars,
              },
              timestamps: {
                streamRequestedAt,
                workerBootRequestedAt: benchmarkWorker.workerBootRequestedAt,
                initializedAt: benchmarkWorker.initializedAt,
                firstAppendAt: firstAppendAtRef.current,
                firstSemanticCommitAt: firstSemanticCommitAtRef.current,
                firstAuthoredTextAt: firstAuthoredTextAtRef.current,
                fenceClosedAt,
                finalizeRequestedAt: streamMdxTimings?.finalizeRequestedAt ?? null,
                finalizeAckAt: streamMdxTimings?.finalizeAckAt ?? null,
                schedulerDrainedAt: streamMdxTimings?.schedulerDrainedAt ?? null,
                decorationReadyAt: streamMdxTimings?.decorationReadyAt ?? null,
                runEnd,
              },
              durations: {
                timeToWorkerInitializedMs:
                  benchmarkWorker.initializedAt !== null
                    ? Math.max(0, benchmarkWorker.initializedAt - (benchmarkWorker.workerBootRequestedAt ?? streamRequestedAt))
                    : null,
                timeFromInitializedToFirstAppendMs:
                  benchmarkWorker.initializedAt !== null && firstAppendAtRef.current !== null
                    ? Math.max(0, firstAppendAtRef.current - benchmarkWorker.initializedAt)
                    : null,
                timeToFirstSemanticCommitMs:
                  firstSemanticCommitAtRef.current !== null
                    ? Math.max(0, firstSemanticCommitAtRef.current - streamRequestedAt)
                    : null,
                coldFirstAuthoredTextMs:
                  isColdRun && firstAuthoredTextAtRef.current !== null
                    ? Math.max(0, firstAuthoredTextAtRef.current - streamRequestedAt)
                    : null,
                postReadyFirstAuthoredTextMs:
                  firstAuthoredTextAtRef.current !== null && benchmarkWorker.initializedAt !== null
                    ? Math.max(0, firstAuthoredTextAtRef.current - benchmarkWorker.initializedAt)
                    : null,
                fenceCloseToFinalizeMs:
                  fenceClosedAt !== null && streamMdxTimings?.finalizeRequestedAt
                    ? Math.max(0, streamMdxTimings.finalizeRequestedAt - fenceClosedAt)
                    : null,
                finalizeRequestToAckDurationMs:
                  streamMdxTimings
                    ? Math.max(0, streamMdxTimings.finalizeAckAt - streamMdxTimings.finalizeRequestedAt)
                    : null,
                workerFinalizeDuration: {
                  available: false,
                  reason: "worker internal finalize parse/enrich time not reported separately in WorkerOut",
                },
                schedulerDrainDurationMs:
                  streamMdxTimings
                    ? Math.max(0, streamMdxTimings.schedulerDrainedAt - streamMdxTimings.finalizeAckAt)
                    : null,
                decorationReadinessDurationMs:
                  streamMdxTimings
                    ? Math.max(0, streamMdxTimings.decorationReadyAt - streamMdxTimings.schedulerDrainedAt)
                    : null,
                totalRunDurationMs: Math.max(0, runEnd - effectiveRunStart),
              },
              frontier: {
                offeredUnits: fixture.length,
                acceptedUnits: acceptedUnitsCount,
                dispatchedUnits: renderer === "streammdx" ? benchmarkWorker.dispatchedUnits : acceptedUnitsCount,
                processedUnits: {
                  available: false,
                  reason: "missing engine hook: publication-time processed UTF-16 frontier",
                  offset: null,
                },
                committedUnits: {
                  available: false,
                  reason: "missing engine hook: publication-correlated committed source frontier",
                  offset: null,
                },
                storeBlockRawCharsTotal,
                visibleSourceRange: {
                  available: false,
                  reason: "unobservable without engine source-range mapping to DOM viewport",
                },
                highlightedSourceRange: {
                  available: false,
                  reason: "unobservable without engine token source-range mapping",
                },
                mountedDomTextChars: liveDom.semanticContent.rawLength,
                presentationNote: "DOM mount / rAF is presentation availability, not proven compositor paint or viewport progress",
                producerSchedule: {
                  nominalTotalMs,
                  actualProducerDurationMs: Math.max(0, lastOfferAtMs - baseTime),
                  maxDelayMs: maxScheduleDelayMs,
                  avgDelayMs: trace.length > 0 ? scheduleDelaySum / trace.length : 0,
                  delayedTicksCount,
                  totalTicks: trace.length,
                },
              },
              resources: {
                mainThreadMemory: {
                  available: memSamples.length > 0,
                  peakUsedJSHeapSizeMB: peakMem,
                },
                workerHeap: {
                  available: false,
                  reason:
                    "page performance.memory reflects only main-thread V8 heap, not isolated Worker heap; worker heap observation unavailable without CDP worker target probe",
                },
                workerCpu: {
                  available: false,
                  reason: "worker CPU usage unavailable without CDP Node/Worker target domain",
                },
              },
              workCounters: {
                available: false,
                reason:
                  "diagnostic stage counters (lines_tokenized, blocks_reprepared, store_records_touched) require the private CounterSeams diagnostic sink which is not on the production path",
                counters: null,
              },
            }
          : null;

        const report: PerfReport = {
          meta: {
            renderer,
            rendererVersion,
            fixtureId,
            scenarioId,
            schedulingPreset,
            scheduling,
            profile,
            policy,
            updateIntervalMs: scenario.updateIntervalMs,
            charRateCps: scenario.charRateCps,
            maxChunkChars: scenario.maxChunkChars,
            fixtureHash,
            chunkTraceHash,
            chunkCount: trace.length,
            runStart: effectiveRunStart,
            runEnd,
            runDurationMs: Math.max(0, runEnd - effectiveRunStart),
            totalChars: fixture.length,
            firstFlushAt: firstFlushAtRef.current,
            userAgent: navigator.userAgent,
            ...(p9FunctionalObservations ? { functionalObservations: p9FunctionalObservations } : {}),
            liveDom,
            campaignObservation,
            resolvedFeatures,
          },
          samples: {
            flushes: flushesRef.current,
            workerPerformance: benchmarkWorker.performanceMetrics,
            patchPerf: {
              totals: window.__STREAM_MDX_PATCH_STATS_TOTALS__ ?? null,
              last: window.__STREAM_MDX_PATCH_STATS_LAST__ ?? null,
            },
            longTasks: longTasksRef.current,
            rafDeltas: rafDeltasRef.current,
            memory: memorySamplesRef.current,
            profiler: profilerSamplesRef.current,
            campaignObservation,
          },
        };

        window.__streammdxPerfReport = report;
      } catch (error) {
        if (cancelled || token !== runTokenRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        console.error("perf harness failed", error);
        window.__streammdxPerfError = message;
      } finally {
        firstContentObserver?.disconnect();
        if (token === runTokenRef.current) {
          window.__streammdxPerfStart = undefined;
          window.__streammdxPerfCollect = undefined;
          stopLongTasks();
          stopRaf();
          stopMemory();
        }
        if (p9Audit) {
          if (previousP9EffectsDescriptor) {
            Object.defineProperty(window, "__streammdxP9T2Effects", previousP9EffectsDescriptor);
          } else {
            Reflect.deleteProperty(window, "__streammdxP9T2Effects");
          }
        }
        benchmarkWorker.dispose();
        resolveDone();
      }
    };

    run();

    return () => {
      cancelled = true;
      if (typeof window !== "undefined" && token === runTokenRef.current && window.__STREAMING_DEBUG__ === patchPerfDebug) {
        if (previousPatchPerfDescriptor) {
          Object.defineProperty(patchPerfDebug, "patchPerf", previousPatchPerfDescriptor);
        } else {
          delete window.__STREAMING_DEBUG__.patchPerf;
        }
      }
      firstContentObserver?.disconnect();
      controller.abort();
      benchmarkWorker.dispose();
      resolveDone();
      stopLongTasks();
      stopRaf();
      stopMemory();
    };
  }, [renderer, fixtureId, patchPerfEnabled, scenarioId, schedulingPreset, scheduling, profile, policy, benchmarkWorker, rendererVersion, highlighting]);

  return (
    <div className="prose">
      <div id="perf-root" ref={rootRef} data-fixture={fixtureId} data-scenario={scenarioId} data-renderer={renderer} data-profile={profile}>
        {restrictedNativeFixture && (renderer !== "streammdx" || profile !== "parity") ? (
          <p>The restricted native streaming fixture requires renderer=streammdx and profile=parity.</p>
        ) : campaignDef?.isCold && !isColdStarted ? null : renderer === "streamdown" ? (
          profilerEnabled ? (
            <Profiler id="Streamdown" onRender={onProfile}>
              <StreamdownHost
                text={streamdownText}
                plugins={streamdownPlugins}
                isAnimating={profile === "rich" ? streamdownIsAnimating : false}
                controls={profile === "rich"}
                onCommit={onStreamdownCommit}
                profile={profile}
              />
            </Profiler>
          ) : (
            <StreamdownHost
              text={streamdownText}
              plugins={streamdownPlugins}
              isAnimating={profile === "rich" ? streamdownIsAnimating : false}
              controls={profile === "rich"}
              onCommit={onStreamdownCommit}
              profile={profile}
            />
          )
        ) : profile === "parity" ? (
          profilerEnabled ? (
            <Profiler id="StreamingMarkdown" onRender={onProfile}>
              <StreamingMarkdown
                ref={handleRef}
                key={queryKey}
                worker={benchmarkWorker.create}
                onError={benchmarkWorker.onError}
                className="markdown-v2-output"
                features={resolvedFeatures}
                scheduling={scheduling}
                caret={false}
                {...(contentComponents ? { contentComponents } : {})}
                onMetrics={onMetrics}
              />
            </Profiler>
          ) : (
            <StreamingMarkdown
              ref={handleRef}
              key={queryKey}
              worker={benchmarkWorker.create}
              onError={benchmarkWorker.onError}
              className="markdown-v2-output"
              features={resolvedFeatures}
              scheduling={scheduling}
              caret={false}
              {...(contentComponents ? { contentComponents } : {})}
              onMetrics={onMetrics}
            />
          )
        ) : profilerEnabled ? (
          <Profiler id="StreamingMarkdown" onRender={onProfile}>
            <StreamingMarkdown
              ref={handleRef}
              key={queryKey}
              worker={benchmarkWorker.create}
              onError={benchmarkWorker.onError}
              className="markdown-v2-output"
              features={resolvedFeatures}
              scheduling={scheduling}
              caret={false}
              contentPolicy="trusted-mdx"
              engines={perfMdxEngines}
              components={registry.getBlockComponentMap()}
              inlineComponents={registry.getInlineComponentMap()}
              tableElements={tableElements}
              htmlElements={htmlElements}
              onMetrics={onMetrics}
            />
          </Profiler>
        ) : (
          <StreamingMarkdown
            ref={handleRef}
            key={queryKey}
            worker={benchmarkWorker.create}
            onError={benchmarkWorker.onError}
            className="markdown-v2-output"
            features={resolvedFeatures}
            scheduling={scheduling}
            caret={false}
            contentPolicy="trusted-mdx"
            engines={perfMdxEngines}
            components={registry.getBlockComponentMap()}
            inlineComponents={registry.getInlineComponentMap()}
            tableElements={tableElements}
            htmlElements={htmlElements}
            onMetrics={onMetrics}
          />
        )}
      </div>
    </div>
  );
}

function StreamdownHost({
  text,
  plugins,
  isAnimating,
  controls,
  onCommit,
  profile,
}: {
  text: string;
  plugins: PluginConfig;
  isAnimating: boolean;
  controls: boolean;
  onCommit: (textLength: number) => void;
  profile: BenchmarkProfile;
}) {
  useLayoutEffect(() => {
    onCommit(text.length);
  }, [text, onCommit]);

  return (
    <Streamdown
      mode="streaming"
      plugins={plugins}
      parseIncompleteMarkdown={true}
      isAnimating={isAnimating}
      animated={false}
      controls={controls}
      linkSafety={profile === "parity" ? PARITY_LINK_SAFETY : undefined}
    >
      {text}
    </Streamdown>
  );
}
