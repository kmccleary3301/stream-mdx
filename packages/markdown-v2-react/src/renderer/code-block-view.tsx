declare const __STREAM_MDX_COUNTERS__: boolean;

import { PATCH_ROOT_ID, dedentIndentedCode, getDefaultCodeWrapperAttributes, stripCodeFence, type TokenLineV1 } from "@stream-mdx/core";
import React from "react";
import { trimProvisionalFenceTail } from "../code-fence-streaming";
import {
  CodeControlsBar,
  copyToClipboard,
  downloadFile,
  getCodeSnippetFilename,
  resolveCodeControls,
} from "../components";
import type { ComponentRegistry } from "../components";
import { DefaultDiffRenderer } from "../components/diff-renderer";
import type { CodeFenceRendererProps } from "../types";
import { useCodeHighlightRequester } from "./code-highlight-context";
import { DeferredRenderContext } from "./deferred-render-context";
import { useRendererChildren, useRendererNode } from "./hooks";
import type { RendererStore } from "./store";
import { useDeferredRender } from "./use-deferred-render";
import { useLazyCodeHighlightRequest } from "./use-lazy-code-highlight-request";
import { DEFAULT_VIRTUALIZED_CODE_CONFIG, type VirtualizedLine, useVirtualizedCode } from "./virtualized-code";

// Private code-rendering owner; block dispatch and finalized wrappers remain in node-views.
export const CodeBlockView: React.FC<{ store: RendererStore; blockId: string; registry: ComponentRegistry }> = React.memo(({ store, blockId, registry }) => {
  const node = useRendererNode(store, blockId);
  const childIds = useRendererChildren(store, blockId);
  const CodeComponent = registry.getBlockComponent("code");
  const deferredConfig = React.useContext(DeferredRenderContext);
  const deferredRef = React.useRef<HTMLDivElement | null>(null);
  const shouldRenderDeferred = useDeferredRender(
    deferredRef,
    deferredConfig ? { ...deferredConfig, enabled: true } : { enabled: false },
  );

  if (!node || !node.block) return null;

  const blockIsFinalized = node.block.isFinalized;
  const nodeVersion = node.version;

  const lines = React.useMemo(() => {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      if (store && typeof store === "object" && "campaignCounters" in store) {
        const storeWithCounters = store as { campaignCounters?: { recordStoreRecordsTouched?(count: number, stage: string): void } };
        storeWithCounters.campaignCounters?.recordStoreRecordsTouched?.(childIds.length, "view");
      }
    }
    const seenIds = new Set<string>();
    const seenIndices = new Set<number>();
    const deduped: VirtualizedLine[] = [];

    for (const childId of childIds) {
      const child = store.getNode(childId);
      if (!child) continue;
      const index = typeof child.props?.index === "number" ? (child.props?.index as number) : deduped.length;
      const text = typeof child.props?.text === "string" ? (child.props?.text as string) : "";
      const html = typeof child.props?.html === "string" ? (child.props?.html as string) : null;
      const tokens = Object.prototype.hasOwnProperty.call(child.props ?? {}, "tokens") ? (child.props?.tokens as TokenLineV1 | null) : undefined;

      if (seenIds.has(child.id) || seenIndices.has(index)) {
        console.warn("[renderer-view] duplicate code line detected", {
          blockId,
          childId: child.id,
          index,
        });
        continue;
      }

      seenIds.add(child.id);
      seenIndices.add(index);
      deduped.push({ id: child.id, index, text, html, tokens });
    }

    // Sort by index to ensure correct line order (important for streaming)
    deduped.sort((a, b) => a.index - b.index);

    return deduped;
  }, [childIds, store, blockId, nodeVersion]);

  const lang = typeof node.props?.lang === "string" ? (node.props?.lang as string) : (node.block.payload.meta?.lang as string | undefined);
  const preAttrs = (node.props?.preAttrs as Record<string, string> | undefined) ?? undefined;
  const codeAttrs = (node.props?.codeAttrs as Record<string, string> | undefined) ?? undefined;
  const blockMeta = (node.block.payload.meta as Record<string, unknown> | undefined) ?? undefined;
  const lazyEnabled = Boolean(blockMeta?.lazyTokenization);
  const lazyTokenizedUntil =
    typeof blockMeta?.lazyTokenizedUntil === "number"
      ? (blockMeta.lazyTokenizedUntil as number)
      : 0;
  const lazyHighlightedLines = Array.isArray(blockMeta?.highlightedLines) ? blockMeta.highlightedLines.length : 0;
  const lazyTokenLines = Array.isArray(blockMeta?.tokenLines) ? blockMeta.tokenLines.length : 0;
  const lazySourceTextLineCount = React.useMemo(() => {
    const raw = typeof node.block?.payload.raw === "string" ? node.block.payload.raw : "";
    const metaCode = typeof blockMeta?.code === "string" ? (blockMeta.code as string) : null;
    const sourceText = resolveCodeSourceText(raw, metaCode, !blockIsFinalized);
    if (sourceText.length === 0) return 0;
    return sourceText.split("\n").length;
  }, [blockMeta, node.block?.payload.raw, blockIsFinalized]);
  const totalLazyLineCount = Math.max(lines.length, lazyHighlightedLines, lazyTokenLines, lazySourceTextLineCount);

  // Use virtualization if enabled and lines exceed threshold
  const virtualizationConfig = DEFAULT_VIRTUALIZED_CODE_CONFIG;
  const virtualizationDisabled =
    typeof process !== "undefined" && typeof process.env === "object" && process.env.STREAM_MDX_DISABLE_VIRTUALIZED_CODE === "true";
  // Keep the full streamed code visible while content is still arriving or while
  // lazy tokenization is progressively filling line metadata. Switching into a
  // windowed view mid-stream causes visible line loss and non-deterministic DOM.
  const canVirtualize = node.block.isFinalized && !lazyEnabled;
  const shouldVirtualize =
    canVirtualize && !virtualizationDisabled && virtualizationConfig.enabled && lines.length >= virtualizationConfig.virtualizeThreshold;
  const virtualization = useVirtualizedCode(lines, shouldVirtualize ? virtualizationConfig : { ...virtualizationConfig, enabled: false });
  const highlightRequester = useCodeHighlightRequester();
  useLazyCodeHighlightRequest({
    blockId,
    blockIsFinalized,
    lazyEnabled,
    lazyTokenizedUntil,
    totalLazyLineCount,
    shouldVirtualize,
    documentIdentity: store.getNode(PATCH_ROOT_ID) ?? store,
    blockEpoch: node.blockEpoch,
  });
  const lastRangeRef = React.useRef<{
    visibleStart: number;
    visibleEnd: number;
    prefetchStart: number;
    prefetchEnd: number;
    tokenizedUntil: number;
  } | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const idleRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!shouldVirtualize || !lazyEnabled || !highlightRequester) return;
    const { visibleStart, visibleEnd, startIndex, endIndex } = virtualization.window;
    if (endIndex <= lazyTokenizedUntil) return;
    const nextRange = {
      visibleStart,
      visibleEnd,
      prefetchStart: startIndex,
      prefetchEnd: endIndex,
      tokenizedUntil: lazyTokenizedUntil,
    };
    const last = lastRangeRef.current;
    if (
      last &&
      last.visibleStart === nextRange.visibleStart &&
      last.visibleEnd === nextRange.visibleEnd &&
      last.prefetchStart === nextRange.prefetchStart &&
      last.prefetchEnd === nextRange.prefetchEnd &&
      last.tokenizedUntil === nextRange.tokenizedUntil
    ) {
      return;
    }
    lastRangeRef.current = nextRange;

    if (rafRef.current !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafRef.current);
    }
    if (typeof requestAnimationFrame === "function") {
      rafRef.current = requestAnimationFrame(() => {
        highlightRequester({
          blockId,
          startLine: visibleStart,
          endLine: visibleEnd,
          priority: "visible",
          reason: "scroll",
        });
        rafRef.current = null;
      });
    } else {
      highlightRequester({
        blockId,
        startLine: visibleStart,
        endLine: visibleEnd,
        priority: "visible",
        reason: "scroll",
      });
    }

    const prefetchNeeded = startIndex < visibleStart || endIndex > visibleEnd;
    if (prefetchNeeded) {
      const idleCallback = (globalThis as { requestIdleCallback?: (cb: (deadline: { didTimeout: boolean }) => void) => number })
        .requestIdleCallback;
      const cancelIdle = (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      if (idleRef.current !== null) {
        if (typeof cancelIdle === "function") {
          cancelIdle(idleRef.current);
        } else if (typeof clearTimeout === "function") {
          clearTimeout(idleRef.current);
        }
      }
      const schedule = () => {
        highlightRequester({
          blockId,
          startLine: startIndex,
          endLine: endIndex,
          priority: "prefetch",
          reason: "buffer",
        });
        idleRef.current = null;
      };
      if (typeof idleCallback === "function") {
        idleRef.current = idleCallback(() => schedule());
      } else if (typeof setTimeout === "function") {
        idleRef.current = setTimeout(schedule, 80) as unknown as number;
      }
    }
  }, [
    blockId,
    highlightRequester,
    lazyEnabled,
    lazyTokenizedUntil,
    shouldVirtualize,
    virtualization.window.visibleStart,
    virtualization.window.visibleEnd,
    virtualization.window.startIndex,
    virtualization.window.endIndex,
  ]);

  // Render virtualized or non-virtualized code
  const highlightedHtml = React.useMemo(() => {
    const blockHtml = node.block?.payload.highlightedHtml ?? "";
    const raw = typeof node.block?.payload.raw === "string" ? node.block.payload.raw : "";
    const metaCode =
      typeof (node.block?.payload.meta as Record<string, unknown> | undefined)?.code === "string"
        ? ((node.block?.payload.meta as Record<string, unknown>).code as string)
        : null;
    const sourceText = resolveCodeSourceText(raw, metaCode, !blockIsFinalized);
    const sourceEndsWithNewline = sourceText.endsWith("\n");
    const sourceLines = sourceText.length > 0 ? sourceText.split("\n") : [];
    const rawFallbackLines = buildCodeFallbackLines(raw, !blockIsFinalized);
    const storeThemes = store.getThemes?.();
    const deterministicWrapperAttrs = getDefaultCodeWrapperAttributes(lang, storeThemes);
    const composedPreAttrs = preAttrs ?? deterministicWrapperAttrs.preAttrs;
    const composedCodeAttrs = codeAttrs ?? deterministicWrapperAttrs.codeAttrs;
    const shouldAppendTerminalNewline = (
      renderedLines: ReadonlyArray<{ index: number; text: string; html?: string | null; id?: string }>,
    ) => {
      if (!sourceEndsWithNewline || renderedLines.length === 0 || lines.length === 0) {
        return false;
      }
      const lastRendered = renderedLines[renderedLines.length - 1];
      const lastKnown = lines[lines.length - 1];
      if (!lastRendered || !lastKnown || lastRendered.index !== lastKnown.index || lastRendered.text === "") {
        return false;
      }

      // Only synthesize the missing terminal newline when the rendered line
      // frontier is aligned with the parent source frontier. During streaming,
      // code-line children can briefly advance ahead of the parent block raw/meta
      // state; trusting the stale parent newline in that window breaks prefix
      // monotonicity by inserting a premature trailing newline.
      const expectedRenderedLineCount = Math.max(0, sourceLines.length - 1);
      const expectedLastRenderedLine = sourceLines.length >= 2 ? sourceLines[sourceLines.length - 2] ?? "" : "";
      return renderedLines.length === expectedRenderedLineCount && lastRendered.text === expectedLastRenderedLine;
    };

    // Always prefer composing from line children if they exist.
    // This keeps streaming and finalized projections on the same code path.
    if (lines.length > 0) {
      const hasLineHtml = lines.some((line) => typeof line.html === "string" && line.html.length > 0);
      if (!hasLineHtml && blockHtml) {
        // If line HTML is missing (e.g. static render with finalized blocks),
        // fall back to the finalized block HTML to preserve deterministic syntax styling.
        return blockHtml;
      }
      if (shouldVirtualize) {
        // Only compose visible lines for virtualized code
        return composeHighlightedHtml(
          virtualization.window.visibleLines,
          composedPreAttrs,
          composedCodeAttrs,
          shouldAppendTerminalNewline(virtualization.window.visibleLines),
        );
      }
      return composeHighlightedHtml(lines, composedPreAttrs, composedCodeAttrs, shouldAppendTerminalNewline(lines));
    }
    if (!shouldVirtualize && blockHtml) {
      const hasHighlightedLines = blockHtml.includes('class="line"');
      if (!hasHighlightedLines && rawFallbackLines.length > 0) {
        return composeHighlightedHtml(
          rawFallbackLines,
          composedPreAttrs,
          composedCodeAttrs,
          sourceEndsWithNewline && rawFallbackLines[rawFallbackLines.length - 1]?.text !== "",
        );
      }
      return blockHtml;
    }
    // Fallback to block's highlightedHtml only if no line children exist yet
    // This handles the initial state before appendLines patches arrive
    if (blockHtml?.trim().match(/^```[\w-]*\s*$/)) {
      if (rawFallbackLines.length > 0) {
        // Return minimal HTML structure with raw text until lines are available.
        return composeHighlightedHtml(
          rawFallbackLines,
          composedPreAttrs,
          composedCodeAttrs,
          sourceEndsWithNewline && rawFallbackLines[rawFallbackLines.length - 1]?.text !== "",
        );
      }
    }
    if (!blockHtml && rawFallbackLines.length > 0) {
      return composeHighlightedHtml(
        rawFallbackLines,
        composedPreAttrs,
        composedCodeAttrs,
        sourceEndsWithNewline && rawFallbackLines[rawFallbackLines.length - 1]?.text !== "",
      );
    }
    return blockHtml;
  }, [blockIsFinalized, shouldVirtualize, node.block?.payload.highlightedHtml, node.block?.payload.meta, lines, lang, preAttrs, codeAttrs, store, virtualization.window.visibleLines, node.block?.payload.raw]);

  const rendered = (
    <CodeComponent
      html={highlightedHtml}
      meta={node.block.payload.meta}
      lines={shouldVirtualize ? virtualization.window.visibleLines : lines}
      lang={lang}
      preAttrs={preAttrs}
      codeAttrs={codeAttrs}
    />
  );

  const effectiveLineCount = React.useMemo(() => {
    if (lines.length > 0) {
      return lines.length;
    }
    // Preserve a stable metadata contract during early streaming checkpoints:
    // once a code block shell exists, report one line until concrete line nodes arrive.
    return 1;
  }, [lines.length]);

  const codeFrameClass = "not-prose flex flex-col rounded-lg border border-input pt-1 font-mono text-sm";
  const codeMetricsAttrs = {
    "data-code-block": "true",
    "data-block-id": blockId,
    "data-code-virtualized": shouldVirtualize ? "true" : "false",
    "data-code-total-lines": String(effectiveLineCount),
    "data-code-mounted-lines": String(shouldVirtualize ? virtualization.window.mountedLines : effectiveLineCount),
    "data-code-window-size": String(virtualization.config.windowSize),
  };

  const normalizedLang = (lang ?? "").trim().toLowerCase();
  const codeRenderer = registry.getCodeRenderer(normalizedLang);
  const raw = typeof node.block.payload.raw === "string" ? node.block.payload.raw : "";
  const metaCode = typeof blockMeta?.code === "string" ? (blockMeta.code as string) : null;
  const sourceText = resolveCodeSourceText(raw, metaCode, !blockIsFinalized);
  const infoText = typeof blockMeta?.info === "string" ? (blockMeta.info as string) : (lang ?? "");

  const resolvedCodeControls = resolveCodeControls(registry.getControls());
  const ControlsComponent = registry.getControlsComponent();

  const codeControlsElement = resolvedCodeControls.enabled ? (
    ControlsComponent ? (
      <ControlsComponent
        type="code"
        blockId={blockId}
        code={sourceText}
        language={lang}
        isFinalized={blockIsFinalized}
        onCopy={() => copyToClipboard(sourceText)}
        onDownload={() => downloadFile(sourceText, getCodeSnippetFilename(lang))}
        labels={resolvedCodeControls.labels}
      />
    ) : (
      <CodeControlsBar
        code={sourceText}
        language={lang}
        config={resolvedCodeControls}
      />
    )
  ) : null;

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

  const elementToFilter = (() => {
    if (codeRenderer) {
      const CustomComponent = typeof codeRenderer === "function" ? codeRenderer : codeRenderer.component;
      const shouldOptInDefer = Boolean(
        (typeof codeRenderer === "object" && codeRenderer !== null && codeRenderer.defer) ||
          (CustomComponent && typeof CustomComponent === "function" && "defer" in CustomComponent && Boolean(CustomComponent.defer)),
      );
      const rendererProps: CodeFenceRendererProps = {
        code: sourceText,
        language: lang ?? "",
        meta: node.block.payload.meta,
        info: infoText,
        isFinalized: node.block.isFinalized,
        blockId,
        renderCode: codeView,
        openLink: registry.getLinkHandler(),
        controls: {
          copy: resolvedCodeControls.copy,
          download: resolvedCodeControls.download,
        },
        copy: () => copyToClipboard(sourceText),
        download: () => downloadFile(sourceText, getCodeSnippetFilename(lang)),
      };

      if (shouldOptInDefer && deferredConfig) {
        return (
          <div ref={deferredRef}>
            {shouldRenderDeferred
              ? React.createElement(CustomComponent, rendererProps)
              : codeView}
          </div>
        );
      }

      return React.createElement(CustomComponent, rendererProps);
    }

    // Structured diff fallback when meta.diffBlocks is present
    if (Array.isArray(blockMeta?.diffBlocks) && blockMeta.diffBlocks.length > 0) {
      const diffView = React.createElement(DefaultDiffRenderer, {
        code: sourceText,
        language: lang ?? "",
        meta: node.block.payload.meta,
        info: infoText,
        isFinalized: node.block.isFinalized,
        blockId,
        renderCode: codeView,
        controls: {
          copy: resolvedCodeControls.copy,
          download: resolvedCodeControls.download,
        },
        copy: () => copyToClipboard(sourceText),
        download: () => downloadFile(sourceText, getCodeSnippetFilename(lang)),
      });
      return codeControlsElement ? wrapWithCodeControls(codeControlsElement, diffView) : diffView;
    }

    // Controls sit beside the code frame, never inside it, so selecting or copying code text excludes button labels.
    return codeControlsElement ? wrapWithCodeControls(codeControlsElement, codeView) : codeView;
  })();

  if (!registry.hasElementFilters()) {
    return React.isValidElement(elementToFilter) ? elementToFilter : <>{elementToFilter}</>;
  }
  const filtered = registry.filterElement(
    { tagName: "pre", properties: { className: codeFrameClass }, blockType: "code" },
    { source: "markdown" },
    () => elementToFilter,
    () => sourceText,
  );
  if (filtered === null || filtered === undefined) return null;
  return React.isValidElement(filtered) ? filtered : <>{filtered}</>;
});

CodeBlockView.displayName = "CodeBlockView";

function wrapWithCodeControls(controls: React.ReactNode, content: React.ReactNode): React.ReactElement {
  return (
    <div className="stream-mdx-code-wrapper relative">
      {controls}
      {content}
    </div>
  );
}
function composeHighlightedHtml(
  lines: ReadonlyArray<{ index: number; text: string; html?: string | null; id?: string; tokens?: TokenLineV1 | null }>,
  preAttrs?: Record<string, string>,
  codeAttrs?: Record<string, string>,
  appendTerminalNewline = false,
): string {
  const lineMarkup = lines
    .map((line) => {
      const content = line.html ?? renderTokenLineHtml(line.tokens) ?? escapeHtml(line.text);
      const dataLine = Number.isFinite(line.index) ? ` data-line="${line.index + 1}"` : "";
      return `<span class="line"${dataLine}>${content}</span>`;
    })
    .join("\n");
  const preAttr = attrsToString(preAttrs);
  const codeAttr = attrsToString(codeAttrs);
  return `<pre${preAttr}><code${codeAttr}>${lineMarkup}${appendTerminalNewline ? "\n" : ""}</code></pre>`;
}

const TOKEN_FONT_STYLE_ITALIC = 1;
const TOKEN_FONT_STYLE_BOLD = 2;
const TOKEN_FONT_STYLE_UNDERLINE = 4;
const TOKEN_FONT_STYLE_STRIKETHROUGH = 8;

function renderTokenLineHtml(tokens: TokenLineV1 | null | undefined): string | null {
  if (!tokens || !Array.isArray(tokens.spans)) {
    return null;
  }
  return mergeRenderableTokenSpans(tokens.spans)
    .map((span) => renderTokenSpanHtml(span))
    .join("");
}

function renderTokenSpanHtml(span: TokenLineV1["spans"][number]): string {
  const dark = span.v?.dark;
  const light = span.v?.light;
  const single = span.s;
  const styles: string[] = [];

  if (dark?.fg) {
    styles.push(`--shiki-dark:${dark.fg}`);
  }
  if (light?.fg) {
    styles.push(`--shiki-light:${light.fg}`);
  }
  if (!light?.fg && !dark?.fg && single?.fg) {
    styles.push(`color:${single.fg}`);
  }

  const fontStyle = light?.fs ?? dark?.fs ?? single?.fs;
  if (typeof fontStyle === "number" && fontStyle > 0) {
    if (fontStyle & TOKEN_FONT_STYLE_ITALIC) {
      styles.push("font-style: italic");
    }
    if (fontStyle & TOKEN_FONT_STYLE_BOLD) {
      styles.push("font-weight: bold");
    }
    const decorations: string[] = [];
    if (fontStyle & TOKEN_FONT_STYLE_UNDERLINE) {
      decorations.push("underline");
    }
    if (fontStyle & TOKEN_FONT_STYLE_STRIKETHROUGH) {
      decorations.push("line-through");
    }
    if (decorations.length > 0) {
      styles.push(`text-decoration: ${decorations.join(" ")}`);
    }
  }

  const content = escapeHtml(span.t ?? "");
  if (styles.length === 0) {
    return content;
  }
  return `<span style="${styles.join(";")}">${content}</span>`;
}

function mergeRenderableTokenSpans(spans: ReadonlyArray<TokenLineV1["spans"][number]>): TokenLineV1["spans"] {
  if (spans.length <= 1) {
    return spans.slice();
  }

  const merged: TokenLineV1["spans"] = [];
  let pendingWhitespace = "";

  for (const span of spans) {
    const text = typeof span.t === "string" ? span.t : "";
    if (/^[\t ]+$/.test(text)) {
      pendingWhitespace += text;
      continue;
    }

    const nextSpan = pendingWhitespace
      ? { ...span, t: `${pendingWhitespace}${text}` }
      : span;
    pendingWhitespace = "";

    const previous = merged[merged.length - 1];
    if (previous && sameTokenSpanStyle(previous, nextSpan)) {
      previous.t += nextSpan.t;
    } else {
      merged.push({ ...nextSpan });
    }
  }

  if (pendingWhitespace) {
    const previous = merged[merged.length - 1];
    if (previous) {
      previous.t += pendingWhitespace;
    } else {
      merged.push({ t: pendingWhitespace });
    }
  }

  return merged;
}

function sameTokenSpanStyle(a: TokenLineV1["spans"][number], b: TokenLineV1["spans"][number]): boolean {
  const variantKeys = new Set<string>([
    ...Object.keys(a.v ?? {}),
    ...Object.keys(b.v ?? {}),
  ]);
  for (const key of variantKeys) {
    const aStyle = a.v?.[key as keyof NonNullable<typeof a.v>];
    const bStyle = b.v?.[key as keyof NonNullable<typeof b.v>];
    if ((aStyle?.fg ?? null) !== (bStyle?.fg ?? null)) return false;
    if ((aStyle?.bg ?? null) !== (bStyle?.bg ?? null)) return false;
    if ((aStyle?.fs ?? null) !== (bStyle?.fs ?? null)) return false;
  }
  if ((a.s?.fg ?? null) !== (b.s?.fg ?? null)) return false;
  if ((a.s?.bg ?? null) !== (b.s?.bg ?? null)) return false;
  if ((a.s?.fs ?? null) !== (b.s?.fs ?? null)) return false;
  return true;
}

function resolveCodeSourceText(raw: string, metaCode: string | null, provisional: boolean): string {
  if (metaCode !== null) {
    return metaCode.replace(/\r\n?/g, "\n");
  }
  if (!raw) return "";
  const normalized = raw.replace(/\r\n?/g, "\n");
  const fenced = stripCodeFence(provisional ? trimProvisionalFenceTail(normalized) : normalized);
  return fenced.hadFence ? fenced.code : normalized;
}

function attrsToString(attrs?: Record<string, string>): string {
  if (!attrs) return "";
  return Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
    .join("");
}

function buildCodeFallbackLines(raw: string, provisional: boolean): Array<{ index: number; text: string; html: null; id: string }> {
  const normalized = normalizeCodeFallbackRaw(raw, provisional);
  if (normalized.length === 0) {
    // When only an opening fence is available (e.g. "```lang\\n"), keep one
    // placeholder line so incremental snapshots do not render an empty code shell.
    if (/^\s*```[^\n]*\n?\s*$/.test(raw)) {
      return [{ id: "temp-0", index: 0, text: "", html: null }];
    }
    return [];
  }
  return normalized.split("\n").map((line, index) => ({
    id: `temp-${index}`,
    index,
    text: line,
    html: null,
  }));
}

function normalizeCodeFallbackRaw(raw: string, provisional: boolean): string {
  if (!raw) return "";
  const normalized = raw.replace(/\r\n?/g, "\n");
  const { code, hadFence } = stripCodeFence(provisional ? trimProvisionalFenceTail(normalized) : normalized);
  if (hadFence) return code;
  return dedentIndentedCode(raw);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return value.replace(/"/g, "&quot;");
}
