"use client";

import type { InlineNode } from "@stream-mdx/core";
import type { RendererStateSnapshot, StreamingSchedulerOptions, StreamingMarkdownProps } from "@stream-mdx/react";
import React, { useEffect, useMemo, useRef, useState } from "react";

import { ComponentRegistry, StreamingMarkdown, type StreamingMarkdownHandle } from "@stream-mdx/react";

import { components as mdxComponents } from "@/mdx-components";
import { configureDemoRegistry, createDemoHtmlElements, createDemoTableElements } from "@/lib/streaming-demo-registry";

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
  liveCodeHighlighting: false,
};

const DEFAULT_SCHEDULING: StreamingSchedulerOptions = {
  batch: "microtask",
  frameBudgetMs: 10,
  maxBatchesPerFlush: 12,
  lowPriorityFrameBudgetMs: 6,
  maxLowPriorityBatchesPerFlush: 2,
  urgentQueueThreshold: 4,
};

type RegressionConfig = {
  features: NonNullable<StreamingMarkdownProps["features"]>;
  scheduling: StreamingSchedulerOptions;
  mdxCompileMode: NonNullable<StreamingMarkdownProps["mdxCompileMode"]>;
  showCodeMeta: boolean;
};

type RegressionSummary = {
  rootChildCount: number;
  selectors: {
    hasTable: boolean;
    hasPre: boolean;
    hasFootnotes: boolean;
    hasMdxPending: boolean;
    hasMdxCompiled: boolean;
    hasBlockquote: boolean;
    hasMath: boolean;
  };
  counts: {
    table: number;
    pre: number;
    blockquote: number;
    katex: number;
    mdxPending: number;
    mdxCompiled: number;
    footnotes: number;
    hr: number;
  };
};

type InvariantViolation = {
  message: string;
};

type StyleTarget = {
  id: string;
  selector: string;
  properties: string[];
  pseudo?: {
    before?: string[];
    after?: string[];
  };
};

type RegressionApi = {
  setConfig: (next: Partial<RegressionConfig>) => Promise<void>;
  setMeta: (meta: { fixtureId?: string; scenarioId?: string }) => void;
  appendAndFlush: (chunk: string) => Promise<void>;
  finalizeAndFlush: () => Promise<void>;
  restart: () => void;
  waitForReady: () => Promise<void>;
  getHtml: () => string;
  getSummary: () => RegressionSummary;
  getDebugBlocks: () => Array<{
    id: string;
    type: string;
    isFinalized: boolean;
    raw: string;
    meta?: Record<string, unknown>;
    inline?: InlineNode[];
  }>;
  getDebugNode: (
    id: string,
  ) =>
    | {
        id: string;
        type: string;
        version: number;
        props: Record<string, unknown>;
        block?: {
          id: string;
          type: string;
          isFinalized: boolean;
          raw: string;
          meta?: Record<string, unknown>;
          inline?: InlineNode[];
        };
      }
    | null;
  getInvariantViolations: () => InvariantViolation[];
  getComputedStyles: (targets: StyleTarget[]) => Record<string, unknown>;
};

declare global {
  interface Window {
    __streammdxRegression?: RegressionApi;
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function collectInvariantViolations(state: RendererStateSnapshot): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const seenIds = new Set<string>();
  let lastRangeStart = Number.NEGATIVE_INFINITY;

  for (const block of state.blocks) {
    if (seenIds.has(block.id)) {
      violations.push({ message: `duplicate block id: ${block.id}` });
    } else {
      seenIds.add(block.id);
    }

    const range = block.payload.range;
    if (range) {
      if (range.from > range.to) {
        violations.push({ message: `invalid range for ${block.id}: ${range.from} > ${range.to}` });
      }
      if (range.from < lastRangeStart) {
        violations.push({ message: `non-monotonic range for ${block.id}: ${range.from} < ${lastRangeStart}` });
      } else {
        lastRangeStart = range.from;
      }
    }

    if (block.type === "mdx") {
      const meta = block.payload.meta as { mdxStatus?: unknown } | undefined;
      const status = typeof meta?.mdxStatus === "string" ? meta.mdxStatus : undefined;
      if (status === "compiled") {
        const hasCompiled = Boolean(block.payload.compiledMdxModule || block.payload.compiledMdxRef);
        if (!hasCompiled) {
          violations.push({ message: `mdx block marked compiled without output: ${block.id}` });
        }
      }
    }
  }

  if (state.queueDepth > 0) {
    violations.push({ message: `queue not drained: ${state.queueDepth}` });
  }
  if (state.pendingBatches > 0) {
    violations.push({ message: `pending batches remaining: ${state.pendingBatches}` });
  }

  return violations;
}

async function waitForStableVersion(
  handle: StreamingMarkdownHandle | null,
  options: { stableFrames?: number; timeoutMs?: number } = {},
): Promise<void> {
  if (!handle) return;
  const stableFrames = options.stableFrames ?? 3;
  const timeoutMs = options.timeoutMs ?? 2000;
  const start = Date.now();
  let lastVersion = handle.getState().rendererVersion;
  let stableCount = 0;
  while (stableCount < stableFrames) {
    await nextFrame();
    const nextVersion = handle.getState().rendererVersion;
    if (nextVersion === lastVersion) {
      stableCount += 1;
    } else {
      stableCount = 0;
      lastVersion = nextVersion;
    }
    if (Date.now() - start > timeoutMs) {
      return;
    }
  }
}

export function HtmlRegressionHarness(): JSX.Element {
  const FLUSH_TIMEOUT_MS = 8000;
  const [config, setConfig] = useState<RegressionConfig>({
    features: DEFAULT_FEATURES,
    scheduling: DEFAULT_SCHEDULING,
    mdxCompileMode: "worker",
    showCodeMeta: false,
  });
  const [instanceKey, setInstanceKey] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<StreamingMarkdownHandle | null>(null);

  const tableElements = useMemo(() => createDemoTableElements(), []);
  const htmlElements = useMemo(() => createDemoHtmlElements(), []);

  const registry = useMemo(() => {
    const next = new ComponentRegistry();
    configureDemoRegistry({
      registry: next,
      tableElements,
      htmlElements,
      showCodeMeta: config.showCodeMeta,
    });
    return next;
  }, [tableElements, htmlElements, config.showCodeMeta]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const waitForFlushAfter = async (prevVersion: number): Promise<void> => {
      const handle = handleRef.current;
      if (!handle) return;
      await new Promise<void>((resolve) => {
        let settled = false;
        const timer = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          unsubscribe?.();
          resolve();
        }, FLUSH_TIMEOUT_MS);
        const unsubscribe = handle.onFlush(() => {
          const nextVersion = handle.getState().rendererVersion;
          if (nextVersion !== prevVersion && !settled) {
            settled = true;
            window.clearTimeout(timer);
            unsubscribe();
            resolve();
          }
        });
      });
    };

    const api: RegressionApi = {
      async setConfig(next) {
        setConfig((prev) => ({ ...prev, ...next }));
        setInstanceKey((prev) => prev + 1);
        await nextFrame();
      },
      setMeta(meta) {
        const root = rootRef.current;
        if (!root) return;
        if (meta.fixtureId) root.dataset.fixture = meta.fixtureId;
        if (meta.scenarioId) root.dataset.scenario = meta.scenarioId;
      },
      async appendAndFlush(chunk) {
        if (!chunk) return;
        const handle = handleRef.current;
        if (!handle) return;
        const prevVersion = handle.getState().rendererVersion;
        handle.append(chunk);
        handle.flushPending();
        await waitForFlushAfter(prevVersion);
        await handle.waitForIdle();
        await nextFrame();
        await nextFrame();
      },
      async finalizeAndFlush() {
        const handle = handleRef.current;
        if (!handle) return;
        const prevVersion = handle.getState().rendererVersion;
        handle.finalize();
        handle.flushPending();
        await waitForFlushAfter(prevVersion);
        await handle.waitForIdle();
        await waitForStableVersion(handle, { stableFrames: 3, timeoutMs: 2000 });
        await nextFrame();
        await nextFrame();
      },
      restart() {
        handleRef.current?.restart();
      },
      async waitForReady() {
        const timeoutMs = 15000;
        const start = Date.now();
        while (true) {
          const ready = Boolean(handleRef.current?.getState().workerReady);
          if (ready) return;
          if (Date.now() - start > timeoutMs) {
            throw new Error("Worker did not initialize within the expected window.");
          }
          await nextFrame();
        }
      },
      getHtml() {
        return rootRef.current?.innerHTML ?? "";
      },
  getSummary() {
    const root = rootRef.current;
    const selectors = {
      hasTable: Boolean(root?.querySelector("table")),
      hasPre: Boolean(root?.querySelector("pre")),
      hasFootnotes: Boolean(root?.querySelector(".footnotes")),
      hasMdxPending: Boolean(root?.querySelector('.markdown-mdx[data-mdx-status="pending"]')),
      hasMdxCompiled: Boolean(root?.querySelector('.markdown-mdx[data-mdx-status="compiled"]')),
      hasBlockquote: Boolean(root?.querySelector("blockquote")),
      hasMath: Boolean(root?.querySelector(".katex")),
    };
    return {
      rootChildCount: root?.children.length ?? 0,
      selectors,
      counts: {
        table: root?.querySelectorAll("table").length ?? 0,
        pre: root?.querySelectorAll("pre").length ?? 0,
        blockquote: root?.querySelectorAll("blockquote").length ?? 0,
        katex: root?.querySelectorAll(".katex").length ?? 0,
        mdxPending: root?.querySelectorAll('.markdown-mdx[data-mdx-status="pending"]').length ?? 0,
        mdxCompiled: root?.querySelectorAll('.markdown-mdx[data-mdx-status="compiled"]').length ?? 0,
        footnotes: root?.querySelectorAll(".footnotes").length ?? 0,
        hr: root?.querySelectorAll("hr").length ?? 0,
      },
    };
  },
      getDebugBlocks() {
        const handle = handleRef.current;
        if (!handle) return [];
        return handle.getState().blocks.map((block) => ({
          id: block.id,
          type: block.type,
          isFinalized: block.isFinalized,
          raw: typeof block.payload.raw === "string" ? block.payload.raw : "",
          meta: block.payload.meta,
          inline: Array.isArray(block.payload.inline) ? block.payload.inline : undefined,
        }));
      },
      getDebugNode(id) {
        const handle = handleRef.current;
        if (!handle) return null;
        const node = handle.getState().store.getNode(id);
        if (!node) return null;
        return {
          id: node.id,
          type: node.type,
          version: node.version,
          props: node.props ? { ...node.props } : {},
          block: node.block
            ? {
                id: node.block.id,
                type: node.block.type,
                isFinalized: node.block.isFinalized,
                raw: typeof node.block.payload.raw === "string" ? node.block.payload.raw : "",
                meta: node.block.payload.meta,
                inline: Array.isArray(node.block.payload.inline) ? node.block.payload.inline : undefined,
              }
            : undefined,
        };
      },
      getInvariantViolations() {
        const handle = handleRef.current;
        if (!handle) return [];
        return collectInvariantViolations(handle.getState());
      },
      getComputedStyles(targets) {
        const root = rootRef.current;
        const out: Record<string, unknown> = {};
        if (!root) return out;
        for (const target of targets) {
          const el = root.querySelector(target.selector) as HTMLElement | null;
          if (!el) {
            out[target.id] = { missing: true, selector: target.selector };
            continue;
          }
          const computed = getComputedStyle(el);
          const selected: Record<string, string> = {};
          for (const prop of target.properties) {
            selected[prop] = computed.getPropertyValue(prop);
          }
          const entry: Record<string, unknown> = {
            selector: target.selector,
            computed: selected,
          };
          if (target.pseudo?.before) {
            const before = getComputedStyle(el, "::before");
            const beforeSelected: Record<string, string> = {};
            for (const prop of target.pseudo.before) {
              beforeSelected[prop] = before.getPropertyValue(prop);
            }
            entry.pseudo = { ...(entry.pseudo as Record<string, unknown>), "::before": beforeSelected };
          }
          if (target.pseudo?.after) {
            const after = getComputedStyle(el, "::after");
            const afterSelected: Record<string, string> = {};
            for (const prop of target.pseudo.after) {
              afterSelected[prop] = after.getPropertyValue(prop);
            }
            entry.pseudo = { ...(entry.pseudo as Record<string, unknown>), "::after": afterSelected };
          }
          out[target.id] = entry;
        }
        return out;
      },
    };

    window.__streammdxRegression = api;
    return () => {
      if (window.__streammdxRegression === api) {
        delete window.__streammdxRegression;
      }
    };
  }, []);

  return (
    <div className="prose markdown">
      <div id="regression-root" ref={rootRef} data-fixture="" data-scenario="">
        <StreamingMarkdown
          key={instanceKey}
          ref={handleRef}
          worker="/workers/markdown-worker.js"
          className="markdown-v2-output"
          features={config.features}
          scheduling={config.scheduling}
          mdxCompileMode={config.mdxCompileMode}
          mdxComponents={mdxComponents as Record<string, React.ComponentType<unknown>>}
          components={registry.getBlockComponentMap()}
          inlineComponents={registry.getInlineComponentMap()}
          tableElements={tableElements}
          htmlElements={htmlElements}
        />
      </div>
    </div>
  );
}
