// Default component implementations for V2 Markdown Renderer
export * from "./bottom-stick-scroll-area";
export * from "./artifact-frame";
export * from "./diff-renderer";
export * from "./katex-math";

import { InlineParser, createTrustedHTML, sanitizeHTML, stripCodeFence } from "@stream-mdx/core";
import { markMdxHydrated, markMdxHydrationError, markMdxHydrationStart } from "../mdx-hydration-metrics";
import { MdxHydrationContext } from "../mdx-hydration-context";
import { loadMdxRuntime } from "../mdx-runtime";
import { useDeferredRender } from "../renderer/use-deferred-render";
import type {
  Block,
  InlineNode,
  MixedContentSegment,
} from "@stream-mdx/core";
import { removeHeadingMarkers } from "@stream-mdx/core";
import React from "react";
import { DEFAULT_INLINE_HTML_RENDERERS, renderInlineHtmlSegment } from "../utils/inline-html";
import type { BlockComponents, BlockRendererOverride, CodeFenceRenderer, HtmlElements, InlineComponents, InlineHtmlRendererMap, MathRenderer, TableElements } from "../types";
import { ArtifactFrame } from "./artifact-frame";
import { DefaultDiffRenderer } from "./diff-renderer";
import { KaTeXBlockMath, KaTeXInlineMath } from "./katex-math";
import { DEFAULT_TABLE_VIRTUALIZATION_CONFIG, resolveTableVirtualizationConfig, type TableVirtualizationConfig, type TableVirtualizationOptions } from "../renderer/virtualized-table";
export { DefaultLinkSafetyModal, type LinkSafetyModalProps } from "./link-safety-modal";

class MdxRuntimeBoundary extends React.Component<
  { resetKey: number; onError: (error: Error) => void; children?: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError(error);
  }

  componentDidUpdate(prevProps: { resetKey: number }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return null;
    }
    return this.props.children;
  }
}

/**
 * Render inline nodes to React elements
 */
export function renderInlineNodes(nodes: InlineNode[], components: InlineComponents): React.ReactNode {
  return nodes.map((node, index) => {
    const key = `${node.kind}-${index}`;

    switch (node.kind) {
      case "text": {
        const textComponent = components.text;
        if (textComponent && textComponent !== defaultInlineComponents.text) {
          return React.createElement(textComponent, { key, text: node.text });
        }
        return React.createElement(React.Fragment, { key, children: node.text });
      }

      case "strong":
        return React.createElement(components.strong, {
          key,
          children: renderInlineNodes(node.children, components),
        });

      case "em":
        return React.createElement(components.em, {
          key,
          children: renderInlineNodes(node.children, components),
        });

      case "strike": {
        const StrikeComponent = components.strike ?? ((props: { children: React.ReactNode }) => React.createElement("del", {}, props.children));
        return React.createElement(StrikeComponent, {
          key,
          children: renderInlineNodes(node.children, components),
        });
      }

      case "code":
        return React.createElement(components.code, { key, text: node.text });

      case "link":
        return React.createElement(
          components.link,
          {
            key,
            href: node.href,
            title: node.title,
            children: renderInlineNodes(node.children, components),
          },
        );

      case "image":
        return React.createElement(components.image, {
          key,
          src: node.src,
          alt: node.alt ?? "",
          title: node.title,
        });

      case "br":
        return React.createElement(
          React.Fragment,
          { key },
          React.createElement(components.br, {} as Record<string, never>),
          "\n",
        );
      case "plugin": {
        const pluginComponent = components[node.name] ?? components.plugin;
        if (pluginComponent) {
          return React.createElement(pluginComponent, {
            key,
            ...node.attrs,
            name: node.name,
            attrs: node.attrs,
            children: node.children ? renderInlineNodes(node.children, components) : undefined,
            raw: node.raw,
          });
        }
        return React.createElement(React.Fragment, { key }, node.raw);
      }

      default: {
        // Handle custom/extensible nodes
        const component = components[node.kind];
        if (component) {
          return React.createElement(component, { key, ...node });
        }
        return null;
      }
    }
  });
}

/**
 * Default inline components
 */
export const defaultInlineComponents: InlineComponents = {
  text: ({ text }) => React.createElement(React.Fragment, {}, text),

  strong: ({ children }) => React.createElement("strong", {}, children),

  em: ({ children }) => React.createElement("em", {}, children),

  strike: ({ children }) => React.createElement("del", {}, children),

  code: ({ text }) =>
    React.createElement(
      "code",
      {
        className: "inline-code",
      },
      text,
    ),

  link: ({ href, title, children }) =>
    React.createElement(
      "a",
      {
        href,
        title,
        className: "markdown-link",
        target: href?.startsWith("http") ? "_blank" : undefined,
        rel: href?.startsWith("http") ? "noopener noreferrer" : undefined,
      },
      children,
    ),

  image: ({ src, alt, title }) =>
    React.createElement("img", {
      src,
      alt,
      title,
      className: "markdown-image",
    }),

  br: () => React.createElement("br"),

  // Custom extensible components
  mention: ({ handle }) =>
    React.createElement(
      "span",
      {
        className: "mention",
        "data-handle": handle,
      },
      `@${handle}`,
    ),

  citation: ({ id }) =>
    React.createElement(
      "span",
      {
        className: "citation",
        "data-citation-id": id,
      },
      `[${id}]`,
    ),

  "math-inline": ({ tex }: { tex: string }) =>
    React.createElement(KaTeXInlineMath, { tex }),

  "math-display": ({ tex }: { tex: string }) =>
    React.createElement(KaTeXBlockMath, { tex }),

  // Footnote inline reference (superscript anchor)
  "footnote-ref": ({ label, number }: { label: string; number?: number }) => {
    const n = number ?? "?";
    const href = number ? `#fn:${n}` : undefined;
    const id = number ? `fnref:${n}` : undefined;
    return React.createElement(
      "sup",
      { className: "footnote-ref" },
      React.createElement("a", { href, id, "data-label": label, style: { color: "var(--foreground)", textDecoration: "underline" } }, String(n)),
    );
  },
};

/**
 * Default block components
 */
export const defaultBlockComponents: BlockComponents = {
  paragraph: ({ inlines, raw, meta, children }) => {
    if (children !== undefined) {
      return React.createElement(
        "p",
        {
          className: "markdown-paragraph",
        },
        children,
      );
    }

    const segments = Array.isArray((meta as { mixedSegments?: MixedContentSegment[] } | undefined)?.mixedSegments)
      ? ((meta as { mixedSegments?: MixedContentSegment[] })?.mixedSegments as MixedContentSegment[])
      : undefined;
    if (segments && segments.length > 0) {
      const structured = renderParagraphMixedSegments(segments, defaultInlineComponents, DEFAULT_INLINE_HTML_RENDERERS);
      if (structured.length === 1) {
        return structured[0];
      }
      return React.createElement(React.Fragment, {}, ...structured);
    }
    const filteredInlines = inlines && raw && inlines.length > 0 ? inlines.filter((node) => !(node.kind === "text" && node.text === raw)) : (inlines ?? []);
    const effectiveInlines: InlineNode[] =
      filteredInlines.length > 0
        ? filteredInlines
        : raw
          ? ([
              {
                kind: "text",
                text: raw,
              },
            ] as InlineNode[])
          : [];
    return React.createElement(
      "p",
      {
        className: "markdown-paragraph",
      },
      effectiveInlines.length > 0 ? renderInlineNodes(effectiveInlines, defaultInlineComponents) : (raw ?? ""),
    );
  },

  heading: ({ level, inlines, text, meta, children }) => {
    const tag = `h${level}` as keyof JSX.IntrinsicElements;
    const onlyPlainText = Array.isArray(inlines) && inlines.length > 0 && inlines.every((node) => node.kind === "text");
    const content =
      children !== undefined
        ? children
        : onlyPlainText
          ? inlines.map((node) => (node.kind === "text" ? node.text : "")).join("")
          : renderInlineNodes(inlines, defaultInlineComponents);
    const headingId = typeof meta?.headingId === "string" && meta.headingId.length > 0 ? meta.headingId : undefined;
    return React.createElement(
      tag,
      {
        className: `markdown-heading markdown-h${level}`,
        ...(text ? { "data-heading-text": text } : {}),
        ...(headingId ? { id: headingId, "data-heading-id": headingId } : {}),
      },
      content,
    );
  },

  code: ({ html, meta, lines, lang, preAttrs, codeAttrs }) => {
    const language = typeof lang === "string" ? lang : typeof meta?.lang === "string" ? String(meta.lang) : "text";
    if (html) {
      return React.createElement("div", {
        className: `markdown-code-block language-${language || "text"}`,
        /* biome-ignore lint/security/noDangerouslySetInnerHtml: highlighted HTML is generated by our sanitizer */
        dangerouslySetInnerHTML: { __html: html },
      });
    }

    // Fallback for non-highlighted code
    const code = meta?.code || "";
    if (lines && lines.length > 0) {
      const preAttributes = attrsToProps(preAttrs);
      const codeAttributes = attrsToProps(codeAttrs);
      return React.createElement(
        "pre",
        {
          ...preAttributes,
          className: preAttributes.className
            ? `${preAttributes.className} markdown-code-block language-${language || "text"}`
            : `markdown-code-block language-${language || "text"}`,
        },
        React.createElement(
          "code",
          {
            ...codeAttributes,
            className: codeAttributes.className ? `${codeAttributes.className} language-${language || "text"}` : `language-${language || "text"}`,
          },
          lines.map((line) =>
            React.createElement("span", {
              key: line.id,
              className: "line",
              /* biome-ignore lint/security/noDangerouslySetInnerHtml: line HTML is sanitized server-side */
              dangerouslySetInnerHTML: { __html: line.html ?? escapeHtml(line.text) },
            }),
          ),
        ),
      );
    }
    return React.createElement("pre", {
      className: `markdown-code-block language-${language || "text"}`,
      children: code,
    });
  },

  blockquote: ({ inlines, renderedContent }) =>
    React.createElement(
      "blockquote",
      {
        className: "markdown-blockquote",
      },
      renderedContent ?? renderInlineNodes(inlines, defaultInlineComponents),
    ),
  hr: (props: React.HTMLAttributes<HTMLHRElement>) => React.createElement("hr", props),

  list: ({ ordered, items }) => {
    if (items.length === 0) {
      return null;
    }
    const tag = ordered ? "ol" : "ul";
    const listStyle = ordered
      ? ({
          ["--list-indent" as const]: `calc(2.5rem + ${String(items.length).length}ch)`,
        } as React.CSSProperties)
      : undefined;
    const listItems = items.map((item, index) =>
      React.createElement(
        "li",
        {
          key: index,
          className: "markdown-list-item",
          "data-counter-text": ordered ? `${index + 1}.` : undefined,
          "data-list-depth": 0,
        },
        renderInlineNodes(item, defaultInlineComponents),
      ),
    );

    return React.createElement(
      tag,
      {
        className: `markdown-list ${ordered ? "ordered" : "unordered"}`,
        style: listStyle,
      },
      listItems,
    );
  },

  html: ({ __trustedHtml, elements, isSanitized, literalTagContent }) => {
    const raw = typeof __trustedHtml === "string" ? __trustedHtml : __trustedHtml.toString();
    // Worker-compiled flows already sanitize HTML at the source using configured allowedTags.
    // Re-sanitizing on the client with fixed DOMPurify policies would strip configured allowed custom tags/attributes.
    const htmlString = isSanitized || typeof window === "undefined" ? raw : sanitizeHTML(raw);
    // If client and mapping provided, convert to React tree using mapping
    if (typeof window !== "undefined" && elements) {
      const content = mapHtmlToReact(htmlString, elements, literalTagContent);
      return React.createElement("div", { className: "markdown-html" }, content);
    }
    // Fallback: trusted injection
    return React.createElement("div", {
      className: "markdown-html",
      /* biome-ignore lint/security/noDangerouslySetInnerHtml: htmlString is sanitized before injection */
      dangerouslySetInnerHTML: { __html: htmlString },
    });
  },

  mdx: ({ compiledRef, compiledModule, status, errorMessage }) => {
    const [Comp, setComp] = React.useState<React.ComponentType | null>(null);
    const [internalError, setInternalError] = React.useState<string | null>(null);
    const [renderError, setRenderError] = React.useState<string | null>(null);
    const [retryKey, setRetryKey] = React.useState(0);
    const hydrationContext = React.useContext(MdxHydrationContext);
    const hydrationController = hydrationContext?.controller ?? null;
    const hydrationOptions = hydrationContext?.options;
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const deferHydration = hydrationOptions?.strategy === "visible";
    const shouldHydrate = useDeferredRender(
      containerRef,
      deferHydration
        ? {
            enabled: true,
            rootMargin: hydrationOptions?.rootMargin,
            idleTimeoutMs: hydrationOptions?.idleTimeoutMs,
            debounceMs: hydrationOptions?.debounceMs,
          }
        : { enabled: false },
    );
    const resolvedId = compiledModule?.id ?? (compiledRef?.id && compiledRef.id !== "pending" ? compiledRef.id : undefined);
    const handleRetry = React.useCallback(() => {
      setInternalError(null);
      setRenderError(null);
      setComp(null);
      setRetryKey((prev) => prev + 1);
    }, []);
    const handleRuntimeError = React.useCallback(
      (error: Error) => {
        const message = error instanceof Error ? error.message : String(error);
        setRenderError(message);
        markMdxHydrationError(resolvedId ?? compiledRef?.id);
      },
      [resolvedId, compiledRef?.id],
    );

    const effectiveStatus: "pending" | "compiled" | "error" = status ? status : resolvedId ? "compiled" : "pending";
    const failureMessage = errorMessage ?? internalError ?? renderError ?? null;
    const moduleDependencies = compiledModule?.dependencies;

    React.useEffect(() => {
      if (!shouldHydrate) {
        return;
      }
      if (status === "error") {
        markMdxHydrationError(resolvedId ?? compiledRef?.id);
        return;
      }

      let cancelled = false;
      async function ensure() {
        let permit: { release: () => void } | null = null;
        try {
          if (status === "error" || !resolvedId || resolvedId === "pending") {
            if (!cancelled) {
              setComp(null);
              setInternalError(null);
            }
            return;
          }

          if (hydrationController) {
            permit = await hydrationController.acquire();
            if (cancelled) {
              permit.release();
              return;
            }
          }

          setInternalError(null);
          setRenderError(null);
          markMdxHydrationStart(resolvedId);
          const { getMDXComponentFactory, registerInlineMdxModule } = await loadMdxRuntime();
          if (compiledModule?.code) {
            registerInlineMdxModule({
              id: compiledModule.id,
              code: compiledModule.code,
              dependencies: moduleDependencies ?? [],
            });
          }

          const factory = getMDXComponentFactory();
          const C = await factory.createComponent({ id: resolvedId });
          if (!cancelled) {
            setComp(() => C);
            setInternalError(null);
            markMdxHydrated(resolvedId);
          }
        } catch (error: unknown) {
          if (!cancelled) {
            const message = error instanceof Error ? error.message : String(error);
            setInternalError(message);
            markMdxHydrationError(resolvedId);
          }
        } finally {
          permit?.release();
        }
      }
      ensure();
      return () => {
        cancelled = true;
      };
    }, [compiledModule?.id, compiledModule?.code, moduleDependencies, resolvedId, status, shouldHydrate, retryKey]);

    const compileMode = compiledModule?.source === "worker" || compiledRef?.id?.startsWith("worker:") ? "worker" : "server";

    const pendingId = resolvedId && resolvedId !== "pending" ? resolvedId : (compiledRef?.id ?? "pending");
    const waitingForVisibility = deferHydration && !shouldHydrate && Boolean(resolvedId);
    const pendingLabel = waitingForVisibility
      ? "MDX ready (hydrate on view)…"
      : compileMode === "worker"
        ? "Compiling MDX (client)…"
        : "Compiling MDX (server)…";
    const message =
      failureMessage ??
      (compileMode === "worker"
        ? "MDX compilation failed in client mode. Try switching back to server rendering or restarting the stream."
        : "MDX compilation failed. Try restarting the stream.");
    const allowRetry = Boolean(internalError || renderError);
    const retryButton = allowRetry
      ? React.createElement(
          "button",
          {
            type: "button",
            className: "markdown-mdx-retry",
            onClick: handleRetry,
          },
          "Retry hydration",
        )
      : null;
    const errorPanel = React.createElement(
      React.Fragment,
      null,
      React.createElement("strong", null, "MDX failed"),
      React.createElement("div", null, message),
    );

    if (Comp && !failureMessage) {
      return React.createElement(
        "div",
        {
          className: "markdown-mdx",
          ref: containerRef,
          "data-mdx-ref": resolvedId ?? compiledRef?.id ?? "compiled",
          "data-mdx-status": failureMessage ? "error" : "compiled",
          "data-mdx-mode": compileMode,
        },
        React.createElement(
          MdxRuntimeBoundary,
          { resetKey: retryKey, onError: handleRuntimeError },
          React.createElement(Comp, {}),
        ),
      );
    }

    if (failureMessage) {
      return React.createElement(
        "div",
        {
          className: "markdown-mdx error",
          ref: containerRef,
          "data-mdx-ref": pendingId,
          "data-mdx-status": "error",
          "data-mdx-mode": compileMode,
        },
        errorPanel,
        retryButton,
      );
    }

    if (!Comp) {
      return React.createElement(
        "div",
        {
          className: "markdown-mdx",
          ref: containerRef,
          "data-mdx-ref": pendingId,
          "data-mdx-status": "pending",
          "data-mdx-mode": compileMode,
        },
        pendingLabel,
      );
    }

  },

  // Footnotes block rendered at page end
  footnotes: ({ items }: { items: Array<{ number: number; inlines: InlineNode[]; label: string }> }) => {
    if (!items || items.length === 0) return React.createElement(React.Fragment, null);

    const listItems = items.map((item) =>
      React.createElement(
        "li",
        { key: item.number, id: `fn:${item.number}` },
        renderInlineNodes(item.inlines, defaultInlineComponents),
        " ",
        React.createElement(
          "a",
          {
            href: `#fnref:${item.number}`,
            className: "footnote-backref",
            "aria-label": "Back to content",
            style: { color: "var(--foreground)", textDecoration: "underline" },
          },
          "↩",
        ),
      ),
    );

    return React.createElement("section", { className: "footnotes" }, React.createElement("hr", {}), React.createElement("ol", {}, listItems));
  },

  // Footnote definition placeholders (render nothing)
  "footnote-def": () => React.createElement(React.Fragment, null),

  // Callouts block
  callout: ({ kind, inlines = [] }: { kind?: string; inlines?: InlineNode[] }) => {
    const tone = (kind || "NOTE").toUpperCase();
    const title = tone.charAt(0) + tone.slice(1).toLowerCase();
    return React.createElement(
      "div",
      { className: `markdown-callout markdown-callout-${tone.toLowerCase()} border rounded p-3 my-3` },
      React.createElement("div", { className: "font-semibold mb-1" }, title),
      inlines.length > 0 ? renderInlineNodes(inlines, defaultInlineComponents) : null,
    );
  },

  // Structured table block (GFM)
  table: ({
    header,
    rows,
    align,
    elements,
  }: { header?: InlineNode[][]; rows: InlineNode[][][]; align?: Array<"left" | "center" | "right" | null>; elements?: Partial<TableElements> }) => {
    const El = getDefaultTableElements(elements);
    const renderCells = (cells: InlineNode[][], tag: "th" | "td", rowIdx: number) =>
      cells.map((cell, i) => {
        const columnAlign = align?.[i] ?? undefined;
        const cellStyle = columnAlign ? ({ textAlign: columnAlign } satisfies React.CSSProperties) : undefined;
        return React.createElement(
          tag === "th" ? El.Th : El.Td,
          {
            key: `${rowIdx}-${i}`,
            style: cellStyle,
            // Also pass align attribute so CSS selectors like [&[align=center]] can be used by consumers
            align: columnAlign ?? undefined,
          },
          renderInlineNodes(cell, defaultInlineComponents),
        );
      });

    return React.createElement(
      El.Table,
      { className: "markdown-table" },
      header && header.length > 0 ? React.createElement(El.Thead, {}, React.createElement(El.Tr, {}, renderCells(header, "th", -1))) : null,
      React.createElement(
        El.Tbody,
        {},
        rows.map((row, r) => React.createElement(El.Tr, { key: r }, renderCells(row, "td", r))),
      ),
    );
  },
};

/**
 * Component registry that allows customization
 */
export class ComponentRegistry {
  private blockComponents: BlockComponents;
  private customBlockComponents = new Set<string>();
  private inlineComponents: InlineComponents;
  private htmlElements: HtmlElements;
  private tableElements: TableElements;
  private literalTagContent?: string[];
  private codeRenderers: Record<string, CodeFenceRenderer> = {};
  private artifactHtml = false;
  private linkHandler: ((url: string) => void) | undefined;
  private blockRenderer?: BlockRendererOverride;
  private blockComponentMapCache: BlockComponents | null = null;
  private tableVirtualization: TableVirtualizationConfig = DEFAULT_TABLE_VIRTUALIZATION_CONFIG;
  private tableVirtualizationListeners = new Set<() => void>();
  private inlineComponentMapCache: InlineComponents | null = null;

  constructor(
    blockComponents: Partial<BlockComponents> = {},
    inlineComponents: Partial<InlineComponents> = {},
    codeRenderers: Record<string, CodeFenceRenderer> = {},
    options?: { artifactHtml?: boolean; mathRenderer?: MathRenderer; blockRenderer?: BlockRendererOverride; tableVirtualization?: TableVirtualizationOptions },
  ) {
    this.blockComponents = { ...defaultBlockComponents, ...blockComponents } as BlockComponents;
    for (const key of Object.keys(blockComponents)) {
      if (blockComponents[key as keyof BlockComponents]) {
        this.customBlockComponents.add(key);
      }
    }
    this.inlineComponents = { ...defaultInlineComponents, ...inlineComponents } as InlineComponents;
    this.htmlElements = getDefaultHtmlElements();
    this.tableElements = getDefaultTableElements();
    if (codeRenderers) {
      this.setCodeRenderers(codeRenderers);
    }
    if (options?.mathRenderer) {
      this.setMathRenderer(options.mathRenderer);
    }
    if (options?.blockRenderer) {
      this.setBlockRenderer(options.blockRenderer);
    }
    if (options?.tableVirtualization !== undefined) {
      this.setTableVirtualization(options.tableVirtualization);
    }
  }

  setCodeRenderers(renderers: Record<string, CodeFenceRenderer>): void {
    const next: Record<string, CodeFenceRenderer> = { ...this.codeRenderers };
    for (const [lang, renderer] of Object.entries(renderers)) {
      next[lang.trim().toLowerCase()] = renderer;
    }
    this.codeRenderers = next;
  }

  setArtifactHtml(enabled: boolean): void {
    this.artifactHtml = enabled;
  }

  /** Link handler handed to code fence renderers as `openLink` (StreamingMarkdown installs its `linkSafety`-aware handler). */
  setLinkHandler(handler: ((url: string) => void) | undefined): void {
    this.linkHandler = handler;
  }

  getLinkHandler(): ((url: string) => void) | undefined {
    return this.linkHandler;
  }

  setBlockRenderer(renderer?: BlockRendererOverride): void {
    this.blockRenderer = renderer;
  }

  /** Finalized blocks go through the `blockRenderer` override (e.g. block transform adapters); streaming blocks never do. */
  renderFinalizedBlock(block: Block, defaultElement: React.ReactElement): React.ReactNode {
    if (this.blockRenderer && block.isFinalized) {
      return this.blockRenderer({
        block,
        element: defaultElement,
      });
    }
    return defaultElement;
  }

  setMathRenderer(mathRenderer: MathRenderer): void {
    if (typeof mathRenderer === "function") {
      this.inlineComponents = {
        ...this.inlineComponents,
        "math-inline": ({ tex }: { tex: string }) => React.createElement(mathRenderer, { tex, display: false }),
        "math-display": ({ tex }: { tex: string }) => React.createElement(mathRenderer, { tex, display: true }),
      } as InlineComponents;
    } else if (mathRenderer && typeof mathRenderer === "object") {
      const inlineComp = mathRenderer.inline;
      const displayComp = mathRenderer.display;
      this.inlineComponents = {
        ...this.inlineComponents,
        ...(inlineComp ? { "math-inline": ({ tex }: { tex: string }) => React.createElement(inlineComp, { tex }) } : {}),
        ...(displayComp ? { "math-display": ({ tex }: { tex: string }) => React.createElement(displayComp, { tex }) } : {}),
      } as InlineComponents;
    }
    this.inlineComponentMapCache = null;
  }

  getCodeRenderer(language: string): CodeFenceRenderer | undefined {
    const normalized = (language ?? "").trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(this.codeRenderers, normalized)) {
      return this.codeRenderers[normalized];
    }
    if (normalized === "artifact" || normalized === "html-artifact") {
      return ArtifactFrame;
    }
    if (normalized === "html" && this.artifactHtml) {
      return ArtifactFrame;
    }
    return undefined;
  }

  getCodeRendererMap(): Record<string, CodeFenceRenderer> {
    return { ...this.codeRenderers };
  }

  /**
   * Update block components
   */
  setBlockComponents(components: Partial<BlockComponents>): void {
    this.blockComponents = { ...this.blockComponents, ...components } as BlockComponents;
    for (const key of Object.keys(components)) {
      if (components[key as keyof BlockComponents]) {
        this.customBlockComponents.add(key);
      }
    }
    this.blockComponentMapCache = null;
  }

  hasCustomBlockComponent(type: string): boolean {
    return this.customBlockComponents.has(type);
  }

  /**
   * Update inline components
   */
  setInlineComponents(components: Partial<InlineComponents>): void {
    this.inlineComponents = { ...this.inlineComponents, ...components } as InlineComponents;
    this.inlineComponentMapCache = null;
  }

  /** Update HTML element mapping for html blocks */
  setHtmlElements(map: Partial<HtmlElements>): void {
    this.htmlElements = { ...this.htmlElements, ...map } as HtmlElements;
  }

  /** Get HTML element mapping */
  getHtmlElements(): HtmlElements {
    return this.htmlElements;
  }

  /** Update literal tag content list */
  setLiteralTagContent(tags?: string[]): void {
    this.literalTagContent = tags;
  }

  /** Get literal tag content list */
  getLiteralTagContent(): string[] | undefined {
    return this.literalTagContent;
  }

  /** Update table element mapping for table blocks */
  setTableElements(map: Partial<TableElements>): void {
    if (
      (map.Table === undefined || map.Table === this.tableElements.Table) &&
      (map.Thead === undefined || map.Thead === this.tableElements.Thead) &&
      (map.Tbody === undefined || map.Tbody === this.tableElements.Tbody) &&
      (map.Tr === undefined || map.Tr === this.tableElements.Tr) &&
      (map.Th === undefined || map.Th === this.tableElements.Th) &&
      (map.Td === undefined || map.Td === this.tableElements.Td)
    ) return;
    this.tableElements = { ...this.tableElements, ...map } as TableElements;
    this.setTableVirtualization(this.tableVirtualization);
  }

  /**
   * Get block component
   */
  getBlockComponent(type: string): React.ComponentType<Record<string, unknown>> {
    return this.blockComponents[type] || this.blockComponents.paragraph;
  }

  /**
   * Get inline components
   */
  getInlineComponents(): InlineComponents {
    return this.inlineComponents;
  }

  getBlockComponentMap(): BlockComponents {
    if (!this.blockComponentMapCache) {
      this.blockComponentMapCache = { ...this.blockComponents } as BlockComponents;
    }
    return this.blockComponentMapCache;
  }

  getInlineComponentMap(): InlineComponents {
    if (!this.inlineComponentMapCache) {
      this.inlineComponentMapCache = { ...this.inlineComponents } as InlineComponents;
    }
    return this.inlineComponentMapCache;
  }

  getTableElements(): TableElements {
    return this.tableElements;
  }

  subscribeTableVirtualization(listener: () => void): () => void {
    this.tableVirtualizationListeners.add(listener);
    return () => {
      this.tableVirtualizationListeners.delete(listener);
    };
  }

  setTableVirtualization(options: TableVirtualizationOptions | undefined): void {
    this.tableVirtualization = resolveTableVirtualizationConfig(options);
    for (const listener of this.tableVirtualizationListeners) {
      listener();
    }
  }

  getTableVirtualization(): TableVirtualizationConfig {
    return this.tableVirtualization;
  }

  /**
   * Render a block
   */
  renderBlock(block: Block): React.ReactElement {
    const Component = this.getBlockComponent(block.type);
    const props = this.getBlockProps(block);
    const element = React.createElement(Component, {
      key: block.id,
      ...props,
    });

    if (block.type === "code") {
      const meta = (block.payload.meta ?? {}) as Record<string, unknown>;
      const lang = typeof meta.lang === "string" ? String(meta.lang) : "";
      const normalizedLang = lang.trim().toLowerCase();
      const codeRenderer = this.getCodeRenderer(normalizedLang);
      const raw = typeof block.payload.raw === "string" ? block.payload.raw : "";
      const metaCode = typeof meta.code === "string" ? (meta.code as string) : null;
      const normalizedRaw = raw.replace(/\r\n?/g, "\n");
      const fenced = stripCodeFence(normalizedRaw);
      const codeText = metaCode !== null ? metaCode.replace(/\r\n?/g, "\n") : (fenced.hadFence ? fenced.code : normalizedRaw);
      const infoText = typeof meta.info === "string" ? (meta.info as string) : lang;

      if (codeRenderer) {
        const RendererComponent = typeof codeRenderer === "function" ? codeRenderer : codeRenderer.component;
        return React.createElement(RendererComponent, {
          key: block.id,
          code: codeText,
          language: lang,
          meta,
          info: infoText,
          isFinalized: block.isFinalized,
          blockId: block.id,
          renderCode: element,
          openLink: this.linkHandler,
        });
      }

      if (Array.isArray(meta.diffBlocks) && meta.diffBlocks.length > 0) {
        return React.createElement(DefaultDiffRenderer, {
          key: block.id,
          code: codeText,
          language: lang,
          meta,
          info: infoText,
          isFinalized: block.isFinalized,
          blockId: block.id,
          renderCode: element,
        });
      }
    }

    return element;
  }

  /**
   * Get props for a block based on its type
   */
  private getBlockProps(block: Block): Record<string, unknown> {
    switch (block.type) {
      case "heading": {
        const meta = (block.payload.meta ?? {}) as Record<string, unknown>;
        const inlineNodes = Array.isArray(block.payload.inline) ? block.payload.inline : [];
        const levelFromMeta = typeof meta.headingLevel === "number" ? meta.headingLevel : undefined;
        const normalizedLevel = Number.isFinite(levelFromMeta) ? Math.min(Math.max(levelFromMeta as number, 1), 6) : undefined;
        const rawHeading = typeof block.payload.raw === "string" ? block.payload.raw : "";
        const headingText =
          typeof meta.headingText === "string" && meta.headingText.trim().length > 0 ? (meta.headingText as string) : removeHeadingMarkers(rawHeading).trim();
        const level = (normalizedLevel ?? this.extractHeadingLevel(rawHeading)) as 1 | 2 | 3 | 4 | 5 | 6;
        const renderedChildren = renderInlineNodes(inlineNodes, this.inlineComponents);
        return {
          level,
          inlines: inlineNodes,
          text: headingText,
          meta,
          children: renderedChildren,
        };
      }
      case "paragraph":
        return {
          inlines: block.payload.inline || [],
          raw: block.payload.raw,
          meta: block.payload.meta,
        };
      case "blockquote":
        return {
          inlines: block.payload.inline || [],
          renderedContent: renderInlineNodes(block.payload.inline || [], this.inlineComponents),
        };

      case "hr": {
        const range = block.payload.range;
        return {
          className: "markdown-hr",
          "data-start": typeof range?.from === "number" ? range.from : undefined,
          "data-end": typeof range?.to === "number" ? range.to : undefined,
        };
      }

      case "code":
        return {
          html: block.payload.highlightedHtml,
          meta: block.payload.meta,
          lang: typeof block.payload.meta?.lang === "string" ? String(block.payload.meta?.lang) : undefined,
        };

      case "list": {
        const items = Array.isArray(block.payload.meta?.items) ? (block.payload.meta?.items as InlineNode[][]) : [];
        return {
          ordered: Boolean(block.payload.meta?.ordered),
          items,
        };
      }

      case "html": {
        const isWorkerSanitized = Boolean(
          block.payload.sanitizedHtml || (block.payload.meta as { sanitized?: boolean } | undefined)?.sanitized,
        );
        const content = block.payload.sanitizedHtml ?? block.payload.raw ?? "";
        return {
          __trustedHtml: isWorkerSanitized || typeof window === "undefined" ? String(content) : createTrustedHTML(String(content)),
          elements: this.htmlElements,
          isSanitized: isWorkerSanitized,
          literalTagContent: this.literalTagContent,
        };
      }

      case "mdx":
        return (() => {
          const meta = block.payload.meta as { mdxStatus?: unknown; mdxError?: unknown } | undefined;
          const rawStatus = typeof meta?.mdxStatus === "string" ? meta.mdxStatus : undefined;
          const status = rawStatus === "pending" || rawStatus === "compiled" || rawStatus === "error" ? rawStatus : undefined;
          const errorMessage = typeof meta?.mdxError === "string" ? String(meta.mdxError) : undefined;
          const compiledModule = block.payload.compiledMdxModule ?? null;
          const compiledRef = block.payload.compiledMdxRef ?? (compiledModule ? { id: compiledModule.id } : undefined);
          return {
            compiledRef: compiledRef ?? { id: "pending" },
            compiledModule,
            status,
            errorMessage,
            raw: typeof block.payload.raw === "string" ? block.payload.raw : undefined,
          };
        })();

      case "table": {
        const header = Array.isArray(block.payload.meta?.header) ? (block.payload.meta?.header as InlineNode[][]) : undefined;
        const rows = Array.isArray(block.payload.meta?.rows) ? (block.payload.meta?.rows as InlineNode[][][]) : [];
        const align = Array.isArray(block.payload.meta?.align) ? (block.payload.meta?.align as Array<"left" | "center" | "right" | null>) : undefined;

        return {
          header,
          rows,
          align,
          elements: this.tableElements,
        };
      }

      case "footnotes": {
        const items = Array.isArray(block.payload.meta?.items)
          ? (block.payload.meta?.items as Array<{ number: number; inlines: InlineNode[]; label: string }>)
          : [];
        return {
          items,
        };
      }

      case "footnote-def":
        return {};

      case "callout": {
        const kind = typeof block.payload.meta?.kind === "string" ? String(block.payload.meta.kind) : undefined;
        const inlineNodes = Array.isArray(block.payload.inline) ? block.payload.inline : [];
        return {
          kind,
          inlines: inlineNodes,
        };
      }

      default:
        return {
          content: block.payload.raw,
          meta: block.payload.meta,
        };
    }
  }

  /**
   * Extract heading level from raw markdown
   */
  private extractHeadingLevel(raw: string): 1 | 2 | 3 | 4 | 5 | 6 {
    const match = raw.match(/^(#{1,6})\s/);
    if (match) {
      return Math.min(match[1].length, 6) as 1 | 2 | 3 | 4 | 5 | 6;
    }
    return 1;
  }
}

function getDefaultHtmlElements(): HtmlElements {
  return {
    // Text semantics
    p: (props: React.HTMLAttributes<HTMLParagraphElement>) => React.createElement("p", props),
    strong: (props: React.HTMLAttributes<HTMLElement>) => React.createElement("strong", props),
    em: (props: React.HTMLAttributes<HTMLElement>) => React.createElement("em", props),
    code: (props: React.HTMLAttributes<HTMLElement>) => React.createElement("code", props),
    pre: (props: React.HTMLAttributes<HTMLPreElement>) => React.createElement("pre", props),
    span: (props: React.HTMLAttributes<HTMLSpanElement>) => React.createElement("span", props),
    br: (props: React.HTMLAttributes<HTMLBRElement>) => React.createElement("br", props),
    hr: (props: React.HTMLAttributes<HTMLHRElement>) => React.createElement("hr", props),
    // Lists
    ul: (props: React.HTMLAttributes<HTMLUListElement>) => React.createElement("ul", props),
    ol: (props: React.HTMLAttributes<HTMLOListElement>) => React.createElement("ol", props),
    li: (props: React.LiHTMLAttributes<HTMLLIElement>) => React.createElement("li", props),
    // Links & media
    a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => React.createElement("a", props),
    img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => React.createElement("img", props),
    // Blockquotes
    blockquote: (props: React.BlockquoteHTMLAttributes<HTMLQuoteElement>) => React.createElement("blockquote", props),
    // Tables
    table: (props: React.TableHTMLAttributes<HTMLTableElement>) => React.createElement("table", props),
    thead: (props: React.HTMLAttributes<HTMLTableSectionElement>) => React.createElement("thead", props),
    tbody: (props: React.HTMLAttributes<HTMLTableSectionElement>) => React.createElement("tbody", props),
    tr: (props: React.HTMLAttributes<HTMLTableRowElement>) => React.createElement("tr", props),
    th: (props: React.ThHTMLAttributes<HTMLTableCellElement>) => React.createElement("th", props),
    td: (props: React.TdHTMLAttributes<HTMLTableCellElement>) => React.createElement("td", props),
    // Generic
    div: (props: React.HTMLAttributes<HTMLDivElement>) => React.createElement("div", props),
  };
}

function getDefaultTableElements(overrides?: Partial<TableElements>): TableElements {
  const base: TableElements = {
    Table: (props: React.TableHTMLAttributes<HTMLTableElement>) => React.createElement("table", props),
    Thead: (props: React.HTMLAttributes<HTMLTableSectionElement>) => React.createElement("thead", props),
    Tbody: (props: React.HTMLAttributes<HTMLTableSectionElement>) => React.createElement("tbody", props),
    Tr: (props: React.HTMLAttributes<HTMLTableRowElement>) => React.createElement("tr", props),
    Th: (props: React.ThHTMLAttributes<HTMLTableCellElement>) => React.createElement("th", props),
    Td: (props: React.TdHTMLAttributes<HTMLTableCellElement>) => React.createElement("td", props),
  };
  return { ...base, ...(overrides || {}) };
}

const DEFAULT_LITERAL_TAGS = new Set(["code", "pre", "kbd", "script", "style", "textarea"]);

export function mapHtmlToReact(
  html: string,
  elements: HtmlElements,
  literalTagContent?: string[],
  parseMarkdown?: (text: string) => React.ReactNode,
): React.ReactNode {
  const ParserClass = typeof DOMParser !== "undefined" ? DOMParser : typeof window !== "undefined" ? window.DOMParser : undefined;
  if (!ParserClass) return null;
  const parser = new ParserClass();
  const doc = parser.parseFromString(html, "text/html");
  const children: React.ReactNode[] = [];
  const literalTags = literalTagContent
    ? new Set([...DEFAULT_LITERAL_TAGS, ...literalTagContent.map((t) => t.toLowerCase())])
    : DEFAULT_LITERAL_TAGS;

  doc.body.childNodes.forEach((node, index) => {
    const element = toReact(node, elements, `root-${index}`, undefined, literalTags, false, parseMarkdown);
    if (element) {
      children.push(element);
    }
  });
  return React.createElement(React.Fragment, {}, ...children);
}

const TABLE_TEXT_FORBIDDEN_PARENTS = new Set(["table", "thead", "tbody", "tfoot", "tr", "colgroup"]);

function toReact(
  node: Node,
  elements: HtmlElements,
  key: string,
  parentTag?: string,
  literalTags?: Set<string>,
  parentIsLiteral?: boolean,
  parseMarkdown?: (text: string) => React.ReactNode,
): React.ReactElement | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    if (parentTag && TABLE_TEXT_FORBIDDEN_PARENTS.has(parentTag) && text.trim().length === 0) {
      return null;
    }
    const content = parentIsLiteral || !parseMarkdown ? text : parseMarkdown(text);
    return React.createElement(React.Fragment, { key }, content);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const isLiteral = parentIsLiteral || (literalTags ? literalTags.has(tag) : false);
  const props: Record<string, unknown> = {};
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name === "class" ? "className" : attr.name;
    props[name] = attr.value;
  }
  const children: React.ReactNode[] = [];
  el.childNodes.forEach((childNode, childIndex) => {
    const child = toReact(childNode, elements, `${key}-${childIndex}`, tag, literalTags, isLiteral, parseMarkdown);
    if (child) {
      children.push(child);
    }
  });
  const component = elements[tag];
  const elementChildren = children.length > 0 ? children : undefined;
  if (component) {
    return React.createElement(component, { ...props, key }, elementChildren);
  }
  return React.createElement(tag, { ...props, key }, elementChildren);
}

function attrsToProps(attrs?: Record<string, string>): React.HTMLAttributes<HTMLElement> {
  if (!attrs) return {};
  type HtmlAttributeRecord = React.HTMLAttributes<HTMLElement> & Record<string, unknown>;
  const result: HtmlAttributeRecord = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") {
      result.className = value;
    } else if (key === "style") {
      result.style = parseStyleAttribute(value);
    } else if (key === "tabindex" || key === "tabIndex") {
      const numericValue = Number(value);
      if (!Number.isNaN(numericValue)) {
        result.tabIndex = numericValue;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function parseStyleAttribute(value: string): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (!value) return style;
  const parts = value.split(";");
  for (const part of parts) {
    if (!part.trim()) continue;
    const [prop, val] = part.split(":");
    if (!prop || !val) continue;
    const camelProp = prop.trim().replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
    (style as Record<string, string>)[camelProp] = val.trim();
  }
  return style;
}

export function renderParagraphMixedSegments(
  segments: MixedContentSegment[],
  inlineComponents: InlineComponents,
  inlineHtmlRenderers: InlineHtmlRendererMap,
  htmlElements?: HtmlElements,
  literalTagContent?: string[],
): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  let inlineBuffer: React.ReactNode[] = [];
  let inlineGroupIndex = 0;

  const pushRenderedNodes = (nodes: React.ReactNode[], target: React.ReactNode[], baseKey: string) => {
    nodes.forEach((node, idx) => {
      if (node === null || node === undefined) return;
      const key = `${baseKey}-${idx}`;
      if (React.isValidElement(node)) {
        target.push(node.key === key ? node : React.cloneElement(node, { key }));
      } else if (typeof node === "string" || typeof node === "number") {
        target.push(React.createElement(React.Fragment, { key }, node));
      } else {
        target.push(React.createElement(React.Fragment, { key }, node as React.ReactNode));
      }
    });
  };

  const ensureArray = (value: React.ReactNode): React.ReactNode[] => {
    if (value === null || value === undefined) {
      return [];
    }
    return Array.isArray(value) ? value : [value];
  };

  const flushInline = () => {
    if (inlineBuffer.length === 0) {
      return;
    }
    const key = `paragraph-inline-group-${inlineGroupIndex++}`;
    result.push(
      React.createElement(
        "p",
        {
          key,
          className: "markdown-paragraph",
        },
        inlineBuffer,
      ),
    );
    inlineBuffer = [];
  };

  segments.forEach((segment, index) => {
    const key = `paragraph-segment-${index}`;
    switch (segment.kind) {
      case "text": {
        const inlineNodes = Array.isArray(segment.inline) ? segment.inline : [];
        if (inlineNodes.length === 0) {
          if (segment.value) {
            inlineBuffer.push(React.createElement(React.Fragment, { key }, segment.value));
          }
          break;
        }

        let chunk: InlineNode[] = [];
        const pushChunk = (chunkNodes: InlineNode[], chunkKey: string) => {
          if (chunkNodes.length === 0) return;
          const rendered = renderInlineNodes(chunkNodes, inlineComponents);
          pushRenderedNodes(ensureArray(rendered), inlineBuffer, chunkKey);
        };

        inlineNodes.forEach((inlineNode, inlineIdx) => {
          if (inlineNode.kind === "math-display") {
            pushChunk(chunk, `${key}-chunk-${inlineIdx}`);
            chunk = [];
            flushInline();
            const rendered = renderInlineNodes([inlineNode], inlineComponents);
            pushRenderedNodes(ensureArray(rendered), result, `${key}-math-${inlineIdx}`);
          } else {
            chunk.push(inlineNode);
          }
        });

        pushChunk(chunk, `${key}-chunk-tail`);
        break;
      }
      case "mdx": {
        const status = segment.status ?? "pending";
        let element: React.ReactNode;
        if (status === "compiled") {
          element = React.createElement("span", { className: "markdown-mdx-inline", "data-mdx-status": "compiled" });
        } else if (status === "error") {
          const message = segment.value || "MDX error";
          element = React.createElement("span", { className: "markdown-mdx-inline text-destructive", "data-mdx-status": "error" }, message);
        } else {
          element = React.createElement("span", { className: "markdown-mdx-inline", "data-mdx-status": status }, segment.value);
        }
        inlineBuffer.push(React.createElement(React.Fragment, { key }, element));
        break;
      }
      case "html": {
        const html = segment.sanitized ?? segment.value;
        const isBlockLevel = isBlockLevelHtml(html);
        const parseMarkdown = (text: string) => {
          if (!text || (!text.includes("*") && !text.includes("_") && !text.includes("[") && !text.includes("`") && !text.includes("#"))) {
            return text;
          }
          return renderInlineNodes(new InlineParser().parse(text), inlineComponents);
        };
        const element = renderInlineHtmlSegment(segment.value, segment.sanitized, {
          key,
          renderers: inlineHtmlRenderers,
          htmlElements,
          literalTagContent,
          parseMarkdown,
        });
        if (isBlockLevel) {
          flushInline();
          if (element) {
            result.push(element);
          } else if (html) {
            result.push(
              React.createElement("div", {
                key,
                className: "markdown-inline-html-block",
                dangerouslySetInnerHTML: { __html: html },
              }),
            );
          }
        } else if (element) {
          inlineBuffer.push(element);
        }
        break;
      }
      default:
        break;
    }
  });

  flushInline();

  if (result.length === 0) {
    return [
      React.createElement(
        "p",
        {
          key: "paragraph-inline-group-0",
          className: "markdown-paragraph",
        },
        inlineBuffer,
      ),
    ];
  }

  return result;
}

function isBlockLevelHtml(html: string | undefined): boolean {
  if (!html) return false;
  const trimmed = html.trim();
  if (!trimmed.startsWith("<")) {
    return false;
  }
  const match = trimmed.match(/^<([A-Za-z][\w:-]*)\b/);
  if (!match) {
    return false;
  }
  const tag = match[1].toLowerCase();
  return BLOCK_LEVEL_TAGS.has(tag);
}

const BLOCK_LEVEL_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "canvas",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
  "math",
]);
