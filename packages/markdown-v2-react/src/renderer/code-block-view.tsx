declare const __STREAM_MDX_COUNTERS__: boolean;

import { getDefaultCodeWrapperAttributes } from "@stream-mdx/core";
import React from "react";
import {
  copyToClipboard,
  downloadFile,
  getCodeSnippetFilename,
  resolveCodeControls,
} from "../components";
import type { ComponentRegistry } from "../components";
import type { ResolvedCodeControls } from "../components/controls";
import { DefaultDiffRenderer } from "../components/diff-renderer";
import type { CodeFenceRendererProps } from "../types";
import { DeferredRenderContext } from "./deferred-render-context";
import { useRendererNode } from "./hooks";
import { subscribeRendererNode } from "./node-subscriptions";
import { CodeLineRangeView } from "./code-line-range";
import { CODE_LINE_RANGE_SIZE } from "./code-state";
import type { RendererStore } from "./store";
import { getStoreResetVersion } from "./store-reset-version";
import { useDeferredRender } from "./use-deferred-render";
import { DEFAULT_VIRTUALIZED_CODE_CONFIG, useVirtualizedCode } from "./virtualized-code";

type CodeBlockViewCounters = {
  recordRecordSlotsAllocated?(count: number, stage: "view"): void;
  recordStoreRecordsTouched?(count: number, stage: "view"): void;
};
type CodeBlockViewCounterStore = RendererStore & { campaignCounters?: CodeBlockViewCounters };
function recordCodeRangeSlots(store: RendererStore): void {
  if (typeof __STREAM_MDX_COUNTERS__ === "undefined" || !__STREAM_MDX_COUNTERS__) return;
  const counters = (store as CodeBlockViewCounterStore).campaignCounters;
  counters?.recordStoreRecordsTouched?.(1, "view");
  counters?.recordRecordSlotsAllocated?.(1, "view");
}
function recordCodeRangeRead(store: RendererStore): void {
  if (typeof __STREAM_MDX_COUNTERS__ === "undefined" || !__STREAM_MDX_COUNTERS__) return;
  (store as CodeBlockViewCounterStore).campaignCounters?.recordStoreRecordsTouched?.(1, "view");
}

const CodeLineRangeTail: React.FC<{
  store: RendererStore;
  blockId: string;
  generation: number;
  resetVersion: number;
  configurationRevision: number;
  chunkStart: number;
}> = React.memo(({ store, blockId, generation, resetVersion, configurationRevision, chunkStart }) => {
  const getFrontier = React.useCallback((): "ready" | "open" | "sealed" | "stale" => {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      recordCodeRangeRead(store);
    }
    if (getStoreResetVersion(store) !== resetVersion) return "stale";
    const current = store.getCodeBlock(blockId);
    if (
      !current ||
      current.source.generation !== generation ||
      current.configurationRevision !== configurationRevision
    ) return "stale";
    if (current.source.lineCount > chunkStart) return "ready";
    return current.source.state === "open" ? "open" : "sealed";
  }, [blockId, chunkStart, configurationRevision, generation, resetVersion, store]);
  const subscribe = React.useCallback((listener: () => void) => {
    let active = true;
    let unsubscribeLines = () => {};
    let unsubscribeNode = () => {};
    const onOwnerChanged = () => {
      if (!active || getFrontier() === "open") return;
      active = false;
      unsubscribeLines();
      unsubscribeNode();
      listener();
    };
    unsubscribeLines = store.subscribeCodeLines(
      blockId,
      chunkStart,
      chunkStart + CODE_LINE_RANGE_SIZE,
      onOwnerChanged,
    );
    unsubscribeNode = subscribeRendererNode(store, blockId, onOwnerChanged);
    if (getFrontier() !== "open") {
      active = false;
      unsubscribeLines();
      unsubscribeNode();
    }
    return () => {
      active = false;
      unsubscribeLines();
      unsubscribeNode();
    };
  }, [blockId, chunkStart, getFrontier, store]);
  const frontier = React.useSyncExternalStore(subscribe, getFrontier, getFrontier);
  return frontier === "ready" ? (
    <CodeLineRangeChain
      store={store}
      blockId={blockId}
      generation={generation}
      resetVersion={resetVersion}
      configurationRevision={configurationRevision}
      chunkStart={chunkStart}
    />
  ) : null;
});

CodeLineRangeTail.displayName = "CodeLineRangeTail";

const CodeLineRangeChain: React.FC<{
  store: RendererStore;
  blockId: string;
  generation: number;
  resetVersion: number;
  configurationRevision: number;
  chunkStart: number;
}> = React.memo(({ store, blockId, generation, resetVersion, configurationRevision, chunkStart }) => {
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    recordCodeRangeSlots(store);
  }
  return (
    <>
      <CodeLineRangeView
        key={`${resetVersion}:${generation}:${chunkStart}`}
        store={store}
        blockId={blockId}
        generation={generation}
        resetVersion={resetVersion}
        configurationRevision={configurationRevision}
        chunkStart={chunkStart}
        rangeStart={chunkStart}
        rangeEnd={chunkStart + CODE_LINE_RANGE_SIZE}
        visibleStart={chunkStart}
        visibleEnd={chunkStart + CODE_LINE_RANGE_SIZE}
      />
      <CodeLineRangeTail
        store={store}
        blockId={blockId}
        generation={generation}
        resetVersion={resetVersion}
        configurationRevision={configurationRevision}
        chunkStart={chunkStart + CODE_LINE_RANGE_SIZE}
      />
    </>
  );
});

CodeLineRangeChain.displayName = "CodeLineRangeChain";


// Private code-rendering owner; block dispatch and finalized wrappers remain in node-views.
export const CodeBlockView: React.FC<{ store: RendererStore; blockId: string; registry: ComponentRegistry }> = React.memo(({ store, blockId, registry }) => {
  const node = useRendererNode(store, blockId);
  const codeBlock = store.getCodeBlock(blockId);
  const codeGeneration = codeBlock?.source.generation ?? null;
  const resetVersion = getStoreResetVersion(store);
  const lineCount = codeBlock?.source.lineCount ?? 0;
  const configurationRevision = codeBlock?.configurationRevision ?? 0;
  const blockMeta = (node?.block?.payload.meta as Record<string, unknown> | undefined) ?? undefined;
  const lazyEnabled = Boolean(blockMeta?.lazyTokenization);
  const blockIsFinalized = codeBlock?.source.state !== "open";
  const canVirtualize = Boolean(codeBlock && blockIsFinalized && !lazyEnabled);
  const virtualizationDisabled =
    typeof process !== "undefined" && typeof process.env === "object" && process.env.STREAM_MDX_DISABLE_VIRTUALIZED_CODE === "true";
  const virtualizationConfig = React.useMemo(
    () => virtualizationDisabled || !canVirtualize
      ? { ...DEFAULT_VIRTUALIZED_CODE_CONFIG, enabled: false }
      : DEFAULT_VIRTUALIZED_CODE_CONFIG,
    [virtualizationDisabled, canVirtualize],
  );
  const virtualization = useVirtualizedCode(
    lineCount,
    codeGeneration ?? -1,
    virtualizationConfig,
  );
  const window = virtualization.window;
  const deferredConfig = React.useContext(DeferredRenderContext);
  const deferredRef = React.useRef<HTMLDivElement | null>(null);
  const shouldRenderDeferred = useDeferredRender(
    deferredRef,
    deferredConfig ? { ...deferredConfig, enabled: true } : { enabled: false },
  );

  const lang =
    codeBlock?.language ??
    (typeof node?.props?.lang === "string" ? node.props.lang : undefined) ??
    (typeof blockMeta?.lang === "string" ? blockMeta.lang : undefined);
  const readCurrentCodeSource = React.useCallback((): string | null => {
    if (getStoreResetVersion(store) !== resetVersion || codeGeneration === null) return null;
    const current = store.getCodeBlock(blockId);
    if (!current || current.source.generation !== codeGeneration) return null;
    return current.lines.materialize().replace(/\r\n?/g, "\n").replace(/\n$/, "");
  }, [blockId, codeGeneration, resetVersion, store]);
  const copyCurrentCode = React.useCallback(async (): Promise<boolean> => {
    const code = readCurrentCodeSource();
    return code === null ? false : copyToClipboard(code);
  }, [readCurrentCodeSource]);
  const downloadCurrentCode = React.useCallback((): void => {
    const code = readCurrentCodeSource();
    if (code !== null) downloadFile(code, getCodeSnippetFilename(lang));
  }, [lang, readCurrentCodeSource]);

  if (!node || !codeBlock) return null;

  const infoText =
    codeBlock.info ||
    (typeof blockMeta?.info === "string" ? blockMeta.info : undefined) ||
    lang ||
    "";
  const preAttrs = (node.props?.preAttrs as Record<string, string> | undefined) ?? undefined;
  const codeAttrs = (node.props?.codeAttrs as Record<string, string> | undefined) ?? undefined;
  const storeThemes = store.getThemes?.();
  const defaultWrapperAttrs = getDefaultCodeWrapperAttributes(lang, storeThemes);
  const composedPreAttrs = preAttrs ?? defaultWrapperAttrs.preAttrs;
  const composedCodeAttrs = codeAttrs ?? defaultWrapperAttrs.codeAttrs;
  const CodeComponent = registry.getBlockComponent("code");
  const normalizedLang = (lang ?? "").trim().toLowerCase();
  const codeRenderer = registry.getCodeRenderer(normalizedLang);
  const resolvedCodeControls = resolveCodeControls(registry.getControls());
  const ControlsComponent = registry.getControlsComponent();
  const shouldVirtualize =
    virtualizationConfig.enabled &&
    virtualization.window.totalLines >= virtualizationConfig.virtualizeThreshold;
  const effectiveLineCount = Math.max(1, lineCount);
  const codeFrameClass = "not-prose flex flex-col rounded-lg border border-input pt-1 font-mono text-sm";
  const codeMetricsAttrs = {
    "data-code-block": "true",
    "data-block-id": blockId,
    "data-code-virtualized": shouldVirtualize ? "true" : "false",
    "data-code-total-lines": String(effectiveLineCount),
    "data-code-mounted-lines": String(shouldVirtualize ? virtualization.window.mountedLines : effectiveLineCount),
    "data-code-window-size": String(virtualization.config.windowSize),
  };

  const useIncrementalRanges =
    !shouldVirtualize &&
    !registry.hasCustomBlockComponent("code") &&
    !codeRenderer &&
    !registry.hasElementFilters();
  let codeLineRanges: React.ReactNode;
  if (useIncrementalRanges) {
    codeLineRanges = (
      <CodeLineRangeTail
        store={store}
        blockId={blockId}
        generation={codeGeneration ?? -1}
        resetVersion={resetVersion}
        configurationRevision={configurationRevision}
        chunkStart={0}
      />
    );
  } else {
    const ranges: React.ReactElement[] = [];
    const firstChunkStart = Math.floor(window.startIndex / CODE_LINE_RANGE_SIZE) * CODE_LINE_RANGE_SIZE;
    for (let chunkStart = firstChunkStart; chunkStart < window.endIndex; chunkStart += CODE_LINE_RANGE_SIZE) {
      const chunkEnd = chunkStart + CODE_LINE_RANGE_SIZE;
      ranges.push(
        <CodeLineRangeView
          key={`${resetVersion}:${codeGeneration}:${chunkStart}`}
          store={store}
          blockId={blockId}
          generation={codeGeneration ?? -1}
          resetVersion={resetVersion}
          configurationRevision={configurationRevision}
          chunkStart={chunkStart}
          rangeStart={Math.max(window.startIndex, chunkStart)}
          rangeEnd={Math.min(window.endIndex, chunkEnd)}
          visibleStart={Math.max(window.visibleStart, chunkStart)}
          visibleEnd={Math.min(window.visibleEnd, chunkEnd)}
        />,
      );
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        const counters = (store as CodeBlockViewCounterStore).campaignCounters;
        counters?.recordStoreRecordsTouched?.(1, "view");
        counters?.recordRecordSlotsAllocated?.(1, "view");
      }
    }
    codeLineRanges = ranges;
  }
  const nativeCodeProps: React.ComponentProps<typeof CodeComponent> = {
    html: "",
    children: codeLineRanges,
    lang,
    preAttrs: composedPreAttrs,
    codeAttrs: composedCodeAttrs,
  };
  const rendered = <CodeComponent {...nativeCodeProps} />;

  const codeView = shouldVirtualize ? (
    (() => {
      const { containerRef, window, handleScroll, lineHeight } = virtualization;
      const spacerTop = window.startIndex * lineHeight;
      const spacerBottom = (window.totalLines - window.endIndex) * lineHeight;
      return (
        <div className={codeFrameClass} {...codeMetricsAttrs}>
          <div
            ref={containerRef}
            className="markdown-code-block-container relative"
            style={{ overflowY: "auto", overflowX: "hidden", maxHeight: "600px" }}
            onScroll={handleScroll}
          >
            <div style={{ height: spacerTop }} aria-hidden="true" />
            {rendered}
            <div style={{ height: spacerBottom }} aria-hidden="true" />
          </div>
        </div>
      );
    })()
  ) : (
    <div className={codeFrameClass} {...codeMetricsAttrs}>
      {rendered}
    </div>
  );

  const renderControls = (): React.ReactNode => {
    if (!resolvedCodeControls.enabled) return null;
    if (ControlsComponent) {
      const code = readCurrentCodeSource() ?? "";
      return (
        <ControlsComponent
          type="code"
          blockId={blockId}
          code={code}
          language={lang}
          isFinalized={blockIsFinalized}
          onCopy={copyCurrentCode}
          onDownload={downloadCurrentCode}
          labels={resolvedCodeControls.labels}
        />
      );
    }
    return (
      <NativeCodeControls
        language={lang}
        config={resolvedCodeControls}
        readCode={readCurrentCodeSource}
      />
    );
  };

  const elementToFilter = (() => {
    if (codeRenderer) {
      const CustomComponent = typeof codeRenderer === "function" ? codeRenderer : codeRenderer.component;
      const shouldOptInDefer = Boolean(
        (typeof codeRenderer === "object" && codeRenderer !== null && codeRenderer.defer) ||
          (CustomComponent && typeof CustomComponent === "function" && "defer" in CustomComponent && Boolean(CustomComponent.defer)),
      );
      const renderCustomCode = (): React.ReactElement => {
        const rendererProps: CodeFenceRendererProps = {
          code: readCurrentCodeSource() ?? "",
          language: lang ?? "",
          meta: blockMeta,
          info: infoText,
          isFinalized: blockIsFinalized,
          blockId,
          renderCode: codeView,
          openLink: registry.getLinkHandler(),
          controls: {
            copy: resolvedCodeControls.copy,
            download: resolvedCodeControls.download,
          },
          copy: copyCurrentCode,
          download: downloadCurrentCode,
        };
        return React.createElement(CustomComponent, rendererProps);
      };

      if (shouldOptInDefer && deferredConfig) {
        return (
          <div ref={deferredRef}>
            {shouldRenderDeferred ? renderCustomCode() : codeView}
          </div>
        );
      }
      return renderCustomCode();
    }

    if (Array.isArray(blockMeta?.diffBlocks) && blockMeta.diffBlocks.length > 0) {
      const diffView = React.createElement(DefaultDiffRenderer, {
        code: "",
        language: lang ?? "",
        meta: blockMeta,
        info: infoText,
        isFinalized: blockIsFinalized,
        blockId,
        renderCode: codeView,
        controls: {
          copy: resolvedCodeControls.copy,
          download: resolvedCodeControls.download,
        },
        copy: copyCurrentCode,
        download: downloadCurrentCode,
      });
      const controls = renderControls();
      return controls ? wrapWithCodeControls(controls, diffView) : diffView;
    }

    const controls = renderControls();
    return controls ? wrapWithCodeControls(controls, codeView) : codeView;
  })();

  if (!registry.hasElementFilters()) {
    return React.isValidElement(elementToFilter) ? elementToFilter : <>{elementToFilter}</>;
  }
  const filtered = registry.filterElement(
    { tagName: "div", properties: { className: codeFrameClass }, blockType: "code" },
    { source: "markdown" },
    () => elementToFilter,
    () => readCurrentCodeSource() ?? "",
  );
  if (filtered === null || filtered === undefined) return null;
  return React.isValidElement(filtered) ? filtered : <>{filtered}</>;
});

CodeBlockView.displayName = "CodeBlockView";

function NativeCodeControls({
  language,
  config,
  readCode,
}: {
  language?: string;
  config: ResolvedCodeControls;
  readCode: () => string | null;
}): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  const { labels } = config;
  const handleCopy = React.useCallback(async () => {
    const code = readCode();
    if (code === null || !(await copyToClipboard(code))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [readCode]);
  const handleDownload = React.useCallback(() => {
    const code = readCode();
    if (code !== null) downloadFile(code, getCodeSnippetFilename(language));
  }, [language, readCode]);

  return (
    <div
      className="stream-mdx-controls stream-mdx-code-controls flex items-center justify-end gap-1 px-2 py-1 text-xs select-none"
      data-stream-mdx-controls="code"
    >
      {language ? (
        <span className="stream-mdx-code-language mr-auto text-muted-foreground opacity-60 text-[11px] font-mono">
          {language}
        </span>
      ) : null}
      {config.copy ? (
        <button
          type="button"
          className="stream-mdx-control stream-mdx-control-copy stream-mdx-control-code-copy inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs hover:bg-muted focus:outline-none"
          data-stream-mdx-control="copy"
          data-stream-mdx-target="code"
          data-stream-mdx-action="copy"
          aria-label={copied ? (labels.copied ?? "Copied!") : (labels.copy ?? "Copy code")}
          onClick={handleCopy}
        >
          {copied ? (labels.copied ?? "Copied!") : (labels.copy ?? "Copy")}
        </button>
      ) : null}
      {config.download ? (
        <button
          type="button"
          className="stream-mdx-control stream-mdx-control-download stream-mdx-control-code-download inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs hover:bg-muted focus:outline-none"
          data-stream-mdx-control="download"
          data-stream-mdx-target="code"
          data-stream-mdx-action="download"
          aria-label={labels.download ?? "Download snippet"}
          onClick={handleDownload}
        >
          {labels.download ?? "Download"}
        </button>
      ) : null}
    </div>
  );
}

function wrapWithCodeControls(controls: React.ReactNode, content: React.ReactNode): React.ReactElement {
  return (
    <div className="stream-mdx-code-wrapper relative">
      {controls}
      {content}
    </div>
  );
}
