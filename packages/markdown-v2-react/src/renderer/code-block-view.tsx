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
import { nativeCodeBlockHtml } from "./native-code-line";
import type { RendererStore } from "./store";
import { getStoreResetVersion } from "./store-reset-version";
import { useDeferredRender } from "./use-deferred-render";
import { useVirtualizedCode } from "./virtualized-code";

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

function codeLineSelectionPoint(node: Node, offset: number): {
  line: HTMLElement;
  lineNumber: number;
  textOffset: number;
} | null {
  const endpoint = node.nodeType === 1 ? node as Element : node.parentElement;
  const line = endpoint?.closest<HTMLElement>(".line[data-line]");
  if (!line && node.nodeType === 3 && node.parentElement?.tagName === "CODE" && node.textContent === "\n") {
    if (offset !== 0 && offset !== 1) return null;
    const previousSibling = node.previousSibling;
    const previousLine = previousSibling?.nodeType === 1
      ? (previousSibling as Element).closest<HTMLElement>(".line[data-line]")
      : null;
    const nextSibling = node.nextSibling;
    const nextLine = nextSibling?.nodeType === 1
      ? (nextSibling as Element).closest<HTMLElement>(".line[data-line]")
      : null;
    const selectedLine = offset === 0 ? previousLine : nextLine ?? previousLine;
    const adjacentLineNumber = Number(selectedLine?.dataset.line);
    if (!selectedLine || !Number.isSafeInteger(adjacentLineNumber) || adjacentLineNumber < 1) return null;
    return {
      line: selectedLine,
      lineNumber: offset === 1 && !nextLine ? adjacentLineNumber + 1 : adjacentLineNumber,
      textOffset: offset === 0 ? selectedLine.textContent?.length ?? 0 : 0,
    };
  }
  const lineNumber = Number(line?.dataset.line);
  if (!line || !Number.isSafeInteger(lineNumber) || lineNumber < 1) return null;

  const prefix = line.ownerDocument.createRange();
  prefix.selectNodeContents(line);
  prefix.setEnd(node, offset);
  return { line, lineNumber, textOffset: prefix.toString().length };
}

function authoredCodeOffset(source: string, lineNumber: number, textOffset: number): number | null {
  let lineStart = 0;
  for (let line = 1; line < lineNumber; line += 1) {
    const separator = source.indexOf("\n", lineStart);
    if (separator < 0) return null;
    lineStart = separator + 1;
  }
  let lineEnd = source.indexOf("\n", lineStart);
  if (lineEnd < 0) lineEnd = source.length;
  if (lineEnd > lineStart && source.charCodeAt(lineEnd - 1) === 13) lineEnd -= 1;
  if (textOffset < 0 || textOffset > lineEnd - lineStart) return null;
  return lineStart + textOffset;
}

function copyAuthoredSelection(event: ClipboardEvent, viewport: HTMLElement, readSource: () => string | null): void {
  if (event.defaultPrevented || !event.clipboardData) return;
  const selection = viewport.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;

  const range = selection.getRangeAt(0);
  const start = codeLineSelectionPoint(range.startContainer, range.startOffset);
  const end = codeLineSelectionPoint(range.endContainer, range.endOffset);
  if (!start || !end || start.line.closest("code") !== end.line.closest("code")) return;
  if (!viewport.contains(start.line) || !viewport.contains(end.line)) return;

  const source = readSource();
  if (source === null) return;
  const sourceStart = authoredCodeOffset(source, start.lineNumber, start.textOffset);
  const sourceEnd = authoredCodeOffset(source, end.lineNumber, end.textOffset);
  if (sourceStart === null || sourceEnd === null || sourceEnd < sourceStart) return;

  event.clipboardData.setData("text/plain", source.slice(sourceStart, sourceEnd));
  event.preventDefault();
}




// Private code-rendering owner; block dispatch and finalized wrappers remain in node-views.
export const CodeBlockView: React.FC<{ store: RendererStore; blockId: string; registry: ComponentRegistry }> = React.memo(({ store, blockId, registry }) => {
  const node = useRendererNode(store, blockId);
  const codeBlock = store.getCodeBlock(blockId);
  const codeGeneration = codeBlock?.source.generation ?? null;
  const resetVersion = getStoreResetVersion(store);
  const lineCount = codeBlock?.source.lineCount ?? 0;
  const effectiveLineCount = Math.max(1, lineCount);
  const configurationRevision = codeBlock?.configurationRevision ?? 0;
  const blockMeta = (node?.block?.payload.meta as Record<string, unknown> | undefined) ?? undefined;
  const blockIsFinalized = codeBlock?.source.state !== "open";
  const canVirtualize = Boolean(codeBlock);
  const subscribeCodeVirtualization = React.useCallback(
    (listener: () => void) => registry.subscribeCodeVirtualization(listener),
    [registry],
  );
  const getCodeVirtualization = React.useCallback(
    () => registry.getCodeVirtualization(),
    [registry],
  );
  const codeVirtualization = React.useSyncExternalStore(
    subscribeCodeVirtualization,
    getCodeVirtualization,
    getCodeVirtualization,
  );
  const virtualizationDisabled =
    typeof process !== "undefined" && typeof process.env === "object" && process.env.STREAM_MDX_DISABLE_VIRTUALIZED_CODE === "true";
  const virtualizationConfig = React.useMemo(
    () => virtualizationDisabled || !canVirtualize
      ? { ...codeVirtualization, enabled: false }
      : codeVirtualization,
    [canVirtualize, codeVirtualization, virtualizationDisabled],
  );
  const codeViewportOwner = React.useMemo(
    () => ({}),
    [blockId, codeGeneration, resetVersion, store],
  );
  const virtualization = useVirtualizedCode(
    lineCount,
    codeGeneration ?? -1,
    virtualizationConfig,
    blockId,
    configurationRevision,
    codeViewportOwner,
  );
  const codeViewportRef = virtualization.containerRef;
  const window = virtualization.window;
  const [fullContentOwner, setFullContentOwner] = React.useState<{
    store: RendererStore;
    blockId: string;
    sourceGeneration: number | null;
    resetVersion: number;
  } | null>(null);
  const fullContentMode = fullContentOwner?.store === store &&
    fullContentOwner.blockId === blockId &&
    fullContentOwner.sourceGeneration === codeGeneration &&
    fullContentOwner.resetVersion === resetVersion;
  const toggleFullContentMode = React.useCallback(() => {
    setFullContentOwner((current) =>
      current?.store === store &&
      current.blockId === blockId &&
      current.sourceGeneration === codeGeneration &&
      current.resetVersion === resetVersion
        ? null
        : { store, blockId, sourceGeneration: codeGeneration, resetVersion },
    );
  }, [blockId, codeGeneration, resetVersion, store]);
  const viewportId = React.useId();
  const fullContentRanges = React.useMemo(
    () => [{
      startIndex: 0,
      endIndex: lineCount,
      visibleStart: window.visibleStart,
      visibleEnd: window.visibleEnd,
      spacerBeforeHeight: 0,
    }],
    [lineCount, window.visibleEnd, window.visibleStart],
  );
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
    return current.lines.materialize();
  }, [blockId, codeGeneration, resetVersion, store]);
  const copyCurrentCode = React.useCallback(async (): Promise<boolean> => {
    const code = readCurrentCodeSource();
    return code === null ? false : copyToClipboard(code);
  }, [readCurrentCodeSource]);
  const downloadCurrentCode = React.useCallback((): void => {
    const code = readCurrentCodeSource();
    if (code !== null) downloadFile(code, getCodeSnippetFilename(lang));
  }, [lang, readCurrentCodeSource]);
  const copyNativeSelection = React.useCallback(
    (event: ClipboardEvent, viewport: HTMLElement) => copyAuthoredSelection(event, viewport, readCurrentCodeSource),
    [readCurrentCodeSource],
  );
  const handleViewportCopy = React.useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => copyNativeSelection(event.nativeEvent, event.currentTarget),
    [copyNativeSelection],
  );
  const shouldVirtualize =
    virtualizationConfig.enabled &&
    virtualization.window.totalLines >= virtualizationConfig.virtualizeThreshold;
  React.useEffect(() => {
    if (!shouldVirtualize) return;
    const viewport = codeViewportRef.current;
    if (!viewport) return;
    const ownerDocument = viewport.ownerDocument;
    const handleDocumentCopy = (event: ClipboardEvent) => {
      if (event.defaultPrevented) return;
      copyNativeSelection(event, viewport);
    };
    ownerDocument.addEventListener("copy", handleDocumentCopy, true);
    return () => ownerDocument.removeEventListener("copy", handleDocumentCopy, true);
  }, [codeViewportRef, copyNativeSelection, shouldVirtualize]);

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
  const codeFrameClass = "not-prose flex flex-col rounded-lg border border-input pt-1 font-mono text-sm";
  const codeMetricsAttrs = {
    "data-code-block": "true",
    "data-block-id": blockId,
    "data-code-virtualized": shouldVirtualize ? "true" : "false",
    "data-code-total-lines": String(effectiveLineCount),
    "data-code-mounted-lines": String(
      shouldVirtualize && !fullContentMode && !virtualization.isPrinting
        ? virtualization.mountedLineCount
        : effectiveLineCount,
    ),
    "data-code-window-size": String(virtualization.config.windowSize),
  };

  const useIncrementalRanges =
    !shouldVirtualize &&
    !registry.hasCustomBlockComponent("code") &&
    !codeRenderer &&
    !registry.hasElementFilters();
  const showFullContent = fullContentMode || virtualization.isPrinting;
  const renderWindow = showFullContent
    ? { ...window, startIndex: 0, endIndex: lineCount }
    : window;
  const renderRanges = showFullContent ? fullContentRanges : virtualization.renderRanges;
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
    const ranges: React.ReactNode[] = [];
    const chunkGroups = new Map<number, {
      chunkStart: number;
      spacerBeforeHeight: number;
      segments: Array<{
        startIndex: number;
        endIndex: number;
        visibleStart: number;
        visibleEnd: number;
        spacerBeforeHeight: number;
      }>;
    }>();
    for (const viewportRange of renderRanges) {
      const firstChunkStart = Math.floor(viewportRange.startIndex / CODE_LINE_RANGE_SIZE) * CODE_LINE_RANGE_SIZE;
      for (let chunkStart = firstChunkStart; chunkStart < viewportRange.endIndex; chunkStart += CODE_LINE_RANGE_SIZE) {
        const chunkEnd = chunkStart + CODE_LINE_RANGE_SIZE;
        const startIndex = Math.max(viewportRange.startIndex, chunkStart);
        const endIndex = Math.min(viewportRange.endIndex, chunkEnd);
        const gapBeforeHeight = startIndex === viewportRange.startIndex ? viewportRange.spacerBeforeHeight : 0;
        let group = chunkGroups.get(chunkStart);
        if (!group) {
          group = { chunkStart, spacerBeforeHeight: gapBeforeHeight, segments: [] };
          chunkGroups.set(chunkStart, group);
        }
        group.segments.push({
          startIndex,
          endIndex,
          visibleStart: Math.max(viewportRange.visibleStart, startIndex),
          visibleEnd: Math.min(viewportRange.visibleEnd, endIndex),
          spacerBeforeHeight: group.segments.length === 0 ? 0 : gapBeforeHeight,
        });
      }
    }
    for (const group of chunkGroups.values()) {
      const { chunkStart } = group;
      const chunkEnd = chunkStart + CODE_LINE_RANGE_SIZE;
      if (group.spacerBeforeHeight > 0) {
        ranges.push(
          <span
            key={`viewport-gap-${chunkStart}`}
            aria-hidden="true"
            style={{ display: "block", height: group.spacerBeforeHeight }}
          />,
        );
      }
      const hasPrimaryRange = renderWindow.startIndex < chunkEnd && renderWindow.endIndex > chunkStart;
      const rangeStart = hasPrimaryRange ? Math.max(renderWindow.startIndex, chunkStart) : chunkStart;
      const rangeEnd = hasPrimaryRange ? Math.min(renderWindow.endIndex, chunkEnd) : chunkStart;
      const visibleStart = hasPrimaryRange ? Math.max(renderWindow.visibleStart, chunkStart) : chunkStart;
      const visibleEnd = hasPrimaryRange ? Math.min(renderWindow.visibleEnd, chunkEnd) : chunkStart;
      ranges.push(
        <CodeLineRangeView
          key={`${resetVersion}:${codeGeneration}:${chunkStart}`}
          store={store}
          blockId={blockId}
          generation={codeGeneration ?? -1}
          resetVersion={resetVersion}
          configurationRevision={configurationRevision}
          chunkStart={chunkStart}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          visibleStart={visibleStart}
          visibleEnd={visibleEnd}
          renderSegments={group.segments}
          selectedLineIndices={virtualization.selectionLineIndices}
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
  // Registered code components predate prepared children and may render `html`; give them the highlighted markup.
  const customCodeLines = registry.hasCustomBlockComponent("code") ? store.getCodeLines(blockId, 0, lineCount) : undefined;
  const nativeCodeProps: React.ComponentProps<typeof CodeComponent> = {
    html: customCodeLines ? nativeCodeBlockHtml(customCodeLines, composedPreAttrs, composedCodeAttrs) : "",
    lines: customCodeLines,
    children: codeLineRanges,
    lang,
    preAttrs: composedPreAttrs,
    codeAttrs: composedCodeAttrs,
  };
  const rendered = <CodeComponent {...nativeCodeProps} />;

  const codeView = shouldVirtualize ? (
    (() => {
      const { containerRef, handleScroll } = virtualization;
      const spacerTopHeight = showFullContent ? 0 : virtualization.spacerTopHeight;
      const spacerBottomHeight = showFullContent ? 0 : virtualization.spacerBottomHeight;
      return (
        <div className={codeFrameClass} {...codeMetricsAttrs}>
          <div
            ref={containerRef}
            id={viewportId}
            className="markdown-code-block-container relative"
            style={{
              overflowY: virtualization.isPrinting ? "visible" : "auto",
              overflowX: virtualization.isPrinting ? "visible" : "hidden",
              maxHeight: virtualization.isPrinting ? "none" : "600px",
            }}
            onScroll={handleScroll}
            onCopy={handleViewportCopy}
          >
            <div style={{ height: spacerTopHeight }} aria-hidden="true" />
            {rendered}
            <div style={{ height: spacerBottomHeight }} aria-hidden="true" />
          </div>
        </div>
      );
    })()
  ) : (
    <div className={codeFrameClass} {...codeMetricsAttrs}>
      {rendered}
    </div>
  );
  const fullContentToggle = shouldVirtualize ? (
    <div className="stream-mdx-code-content-toggle flex items-center justify-end gap-1 px-2 py-1 text-xs select-none">
      <button
        type="button"
        className="stream-mdx-control stream-mdx-control-code-full-content inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs hover:bg-muted focus:outline-none"
        aria-controls={viewportId}
        aria-pressed={fullContentMode}
        onClick={toggleFullContentMode}
      >
        Show full content
      </button>
    </div>
  ) : null;

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
          code: typeof blockMeta?.code === "string" ? blockMeta.code : readCurrentCodeSource() ?? "",
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
  const withFullContentToggle = (content: React.ReactNode): React.ReactElement => {
    if (fullContentToggle) return <>{fullContentToggle}{content}</>;
    return React.isValidElement(content) ? content : <>{content}</>;
  };


  if (!registry.hasElementFilters()) {
    return withFullContentToggle(
      React.isValidElement(elementToFilter) ? elementToFilter : <>{elementToFilter}</>,
    );
  }
  const filtered = registry.filterElement(
    { tagName: "div", properties: { className: codeFrameClass }, blockType: "code" },
    { source: "markdown" },
    () => elementToFilter,
    () => readCurrentCodeSource() ?? "",
  );
  if (filtered === null || filtered === undefined) return null;
  return withFullContentToggle(React.isValidElement(filtered) ? filtered : <>{filtered}</>);
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
  const copyLease = React.useRef(0);
  const copyResetTimeout = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => {
    return () => {
      copyLease.current += 1;
      clearTimeout(copyResetTimeout.current);
    };
  }, [readCode]);
  const handleCopy = React.useCallback(async () => {
    const code = readCode();
    const lease = copyLease.current;
    if (code === null || !(await copyToClipboard(code)) || lease !== copyLease.current) return;
    setCopied(true);
    clearTimeout(copyResetTimeout.current);
    copyResetTimeout.current = setTimeout(() => setCopied(false), 2000);
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
