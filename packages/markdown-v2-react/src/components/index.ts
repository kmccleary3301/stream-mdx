import { trimProvisionalFenceTail } from "../code-fence-streaming";
// Default component implementations for V2 Markdown Renderer
export * from "./bottom-stick-scroll-area";
export * from "./diff-renderer";
export * from "./katex-math";
export * from "./controls";
export {
  STREAM_MDX_ANIMATION_CSS,
  DEFAULT_ANIMATED_OPTIONS,
  AnimationTimeline,
  splitTextSegments,
  splitWordSegments,
  resolveAnimatedOptions,
  type RenderInlineAnimationContext,
} from "../animation";
export { defaultUrlTransform, type UrlTransform, type UrlTransformContext } from "@stream-mdx/core";
import { InlineParser, createTrustedHTML, defaultUrlTransform, isForbiddenAttribute, isSafeStyleDeclaration, sanitizeHTML, stripCodeFence } from "@stream-mdx/core";
import type { UrlTransform } from "@stream-mdx/core";
import type { ContentComponentsMap } from "./content-components";
import type {
  Block,
  FootnoteItem,
  HtmlTreeNode,
  InlineNode,
  MixedContentSegment,
} from "@stream-mdx/core";
import { removeHeadingMarkers } from "@stream-mdx/core";
import React from "react";
import { DEFAULT_INLINE_HTML_RENDERERS, renderHtmlInlineNode, renderInlineHtmlSegment } from "../utils/inline-html";
import { renderOwnedHtmlTree, type OwnedHtmlRenderContext } from "./owned-html";
import { TrustedMdxInlineOwner } from "../trusted-mdx/native-inline";
import type {
  AllowElementFn,
  AnimatedProp,
  CodeNodeViewProps,
  ControlsComponentProps,
  ControlsConfig,
  ElementFilterOptions,
  ElementFilterContext,
  ElementFilterDescriptor,
  HtmlElements,
  GenericComponent,
  InlineComponents,
  InlineHtmlRendererMap,
  MathEngine,
  NodeViewActions,
  NodeViewMetadata,
  NodePresentations,
  PresentationProps,
  TableElements,
} from "../types";
import { mergeNodePresentationProps, renderPresentedNode, resolveNodePresentation, validateNodePresentations } from "../renderer/node-presentations";
import { AnimationTimeline, resolveAnimatedOptions, splitTextSegments, type RenderInlineAnimationContext, type ResolvedAnimatedOptions } from "../animation";
import { DefaultDiffRenderer } from "./diff-renderer";
import { KaTeXBlockMath, KaTeXInlineMath } from "./katex-math";
import { DEFAULT_TABLE_VIRTUALIZATION_CONFIG, resolveTableVirtualizationConfig, type TableVirtualizationConfig, type TableVirtualizationOptions } from "../renderer/virtualized-table";
import {
  DEFAULT_VIRTUALIZED_CODE_CONFIG,
  resolveVirtualizedCodeConfig,
  type VirtualizedCodeConfig,
} from "../renderer/virtualized-code";
import {
  CodeControlsBar,
  TableControlsBar,
  copyToClipboard,
  downloadFile,
  getCodeSnippetFilename,
  inlineToPlainText,
  resolveCodeControls,
  resolveTableControls,
  tableToCsv,
  tableToMarkdown,
  tableToTsv,
} from "./controls";
export { DefaultLinkSafetyModal, type LinkSafetyModalProps } from "./link-safety-modal";

function presentationText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(presentationText).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return presentationText(node.props.children);
  }
  return "";
}

/**
 * Render inline nodes to React elements
 */
export function renderInlineNodes(
  nodes: ReadonlyArray<InlineNode>,
  components: InlineComponents,
  urlTransform?: UrlTransform,
  registry?: ComponentRegistry,
  parentTagName?: string,
  animationContext?: RenderInlineAnimationContext,
): React.ReactNode {
  return nodes.map((node, index) => {
    const key = `${node.kind}-${index}`;
    const itemChildContext = animationContext?.animated && !animationContext.isFinalized
      ? {
          ...animationContext,
          nodeKeyPrefix: animationContext.nodeKeyPrefix ? `${animationContext.nodeKeyPrefix}:${key}` : key,
        }
      : animationContext;
    const presentInline = (nativeView: React.ReactNode, renderedChildren?: React.ReactNode) => {
      if (!registry) {
        return nativeView;
      }
      return registry.renderInlinePresentation(node, nativeView, key, itemChildContext, renderedChildren);
    };

    switch (node.kind) {
      case "text": {
        const textComponent = components.text;
        if (textComponent && textComponent !== defaultInlineComponents.text) {
          return presentInline(React.createElement(textComponent, { key, text: node.text }));
        }
        if (animationContext?.animated && !animationContext.isFinalized && animationContext.timeline) {
          const { animated, timeline, nodeKeyPrefix } = animationContext;
          const nodeKey = nodeKeyPrefix ? `${nodeKeyPrefix}:${key}` : key;
          const segments = splitTextSegments(node.text, animated.sep);
          const state = timeline.getNodeState(nodeKey);
          if (segments.length > state.count) {
            const newCount = segments.length - state.count;
            const newDelays = timeline.schedule(newCount, animated.stagger);
            state.delays.push(...newDelays);
            state.count = segments.length;
          } else if (segments.length < state.count) {
            state.count = segments.length;
            state.delays.length = segments.length;
          }
          const animName = animated.animationName;
          const durationStr = animated.durationStr;
          const spans = segments.map((segment, segmentIndex) => {
            const delay = state.delays[segmentIndex] ?? 0;
            const animStyle: React.CSSProperties & Record<string, string | number> = {
              "--sm-anim-duration": durationStr,
              "--sm-anim-easing": animated.easing,
              "--sm-anim-delay": `${delay}ms`,
            };
            if (animName) {
              animStyle["--sm-anim-name"] = animName;
              animStyle.animationName = animName;
            }
            return React.createElement(
              "span",
              {
                key: segmentIndex,
                className: "stream-mdx-anim",
                style: animStyle,
              },
              segment,
            );
          });
          return presentInline(React.createElement(React.Fragment, { key }, ...spans));
        }
        return presentInline(React.createElement(React.Fragment, { key, children: node.text }));
      }

      case "strong": {
        if (!registry?.hasElementFilters()) {
          return presentInline(React.createElement(components.strong, {
            key,
            children: renderInlineNodes(node.children, components, urlTransform, registry, "strong", itemChildContext),
          }));
        }
        const renderChildren = () => renderInlineNodes(node.children, components, urlTransform, registry, "strong", itemChildContext);
        const renderElement = () =>
          presentInline(React.createElement(components.strong, {
            key,
            children: renderChildren(),
          }));
        return registry.filterElement(
          { tagName: "strong", properties: { key }, blockType: undefined },
          { source: "markdown", parentTagName },
          renderElement,
          renderChildren,
        );
      }

      case "em": {
        if (!registry?.hasElementFilters()) {
          return presentInline(React.createElement(components.em, {
            key,
            children: renderInlineNodes(node.children, components, urlTransform, registry, "em", itemChildContext),
          }));
        }
        const renderChildren = () => renderInlineNodes(node.children, components, urlTransform, registry, "em", itemChildContext);
        const renderElement = () =>
          presentInline(React.createElement(components.em, {
            key,
            children: renderChildren(),
          }));
        return registry.filterElement(
          { tagName: "em", properties: { key }, blockType: undefined },
          { source: "markdown", parentTagName },
          renderElement,
          renderChildren,
        );
      }

      case "strike": {
        const StrikeComponent = components.strike ?? ((props: { children: React.ReactNode }) => React.createElement("del", {}, props.children));
        if (!registry?.hasElementFilters()) {
          return presentInline(React.createElement(StrikeComponent, {
            key,
            children: renderInlineNodes(node.children, components, urlTransform, registry, "del", itemChildContext),
          }));
        }
        const renderChildren = () => renderInlineNodes(node.children, components, urlTransform, registry, "del", itemChildContext);
        const renderElement = () =>
          presentInline(React.createElement(StrikeComponent, {
            key,
            children: renderChildren(),
          }));
        return registry.filterElement(
          { tagName: "del", properties: { key }, blockType: undefined },
          { source: "markdown", parentTagName },
          renderElement,
          renderChildren,
        );
      }

      case "code": {
        if (!registry?.hasElementFilters()) {
          return presentInline(React.createElement(components.code, { key, text: node.text }));
        }
        const renderChildren = () => node.text;
        const renderElement = () => presentInline(React.createElement(components.code, { key, text: node.text }));
        return registry.filterElement(
          { tagName: "code", properties: { key, text: node.text }, blockType: undefined },
          { source: "markdown", parentTagName },
          renderElement,
          renderChildren,
        );
      }

      case "link": {
        if (node.autolink && registry?.isAutolinkProtocolDisabled(node.href)) {
          return renderInlineNodes(node.children, components, urlTransform, registry, parentTagName, itemChildContext);
        }
        const transform = urlTransform ?? defaultUrlTransform;
        const safeHref = transform(node.href ?? "", "href", { source: "markdown" });
        if (!registry?.hasElementFilters()) {
          return presentInline(React.createElement(
            components.link,
            {
              key,
              ...(safeHref != null ? { href: safeHref } : {}),
              title: node.title,
              children: renderInlineNodes(node.children, components, urlTransform, registry, "a", itemChildContext),
            },
          ));
        }
        const renderChildren = () => renderInlineNodes(node.children, components, urlTransform, registry, "a", itemChildContext);
        const renderElement = () =>
          presentInline(React.createElement(
            components.link,
            {
              key,
              ...(safeHref != null ? { href: safeHref } : {}),
              title: node.title,
              children: renderChildren(),
            },
          ));
        return registry.filterElement(
          { tagName: "a", properties: { key, href: safeHref, title: node.title }, blockType: undefined },
          { source: "markdown", parentTagName },
          renderElement,
          renderChildren,
        );
      }

      case "image": {
        const transform = urlTransform ?? defaultUrlTransform;
        const safeSrc = transform(node.src ?? "", "src", { source: "markdown" });
        if (!registry?.hasElementFilters()) {
          return presentInline(React.createElement(components.image, {
            key,
            ...(safeSrc != null ? { src: safeSrc } : {}),
            alt: node.alt ?? "",
            title: node.title,
          }));
        }
        const renderElement = () =>
          presentInline(React.createElement(components.image, {
            key,
            ...(safeSrc != null ? { src: safeSrc } : {}),
            alt: node.alt ?? "",
            title: node.title,
          }));
        return registry.filterElement(
          { tagName: "img", properties: { key, src: safeSrc, alt: node.alt ?? "", title: node.title }, blockType: undefined },
          { source: "markdown", parentTagName },
          renderElement,
          undefined,
        );
      }

      case "br": {
        if (!registry?.hasElementFilters()) {
          return presentInline(React.createElement(
            React.Fragment,
            { key },
            React.createElement(components.br, {} as Record<string, never>),
            "\n",
          ));
        }
        const renderElement = () =>
          presentInline(React.createElement(
            React.Fragment,
            { key },
            React.createElement(components.br, {} as Record<string, never>),
            "\n",
          ));
        return registry.filterElement(
          { tagName: "br", properties: { key }, blockType: undefined },
          { source: "markdown", parentTagName },
          renderElement,
          undefined,
        );
      }
      case "plugin": {
        const pluginComponent = components[node.name] ?? components.plugin;
        const hasExtensionPresentation = registry?.getNodePresentation(`extension:${node.name}`) !== undefined;
        const pluginChildren = node.children && (pluginComponent || hasExtensionPresentation)
          ? renderInlineNodes(node.children, components, urlTransform, registry, parentTagName, itemChildContext)
          : undefined;
        if (pluginComponent) {
          return presentInline(React.createElement(pluginComponent, {
            key,
            ...node.attrs,
            name: node.name,
            attrs: node.attrs,
            children: pluginChildren,
            raw: node.raw,
          }), pluginChildren);
        }
        if (hasExtensionPresentation) {
          return presentInline(React.createElement(React.Fragment, { key }, pluginChildren ?? node.raw), pluginChildren);
        }
        return presentInline(React.createElement(React.Fragment, { key }, node.raw));
      }

      case "trusted-mdx-inline":
        return React.createElement(TrustedMdxInlineOwner, { key, ownerId: node.ownerId, source: node.raw });

      case "html": {
        const children = node.children ? renderInlineNodes(node.children, components, urlTransform, registry, node.tagName?.toLowerCase(), itemChildContext) : undefined;
        const textValue = node.children?.map((child) => child.kind === "text" ? child.text : "").join("");
        const htmlRenderer = components.html;
        if (htmlRenderer && !registry?.isDefaultHtmlInlineRenderer(htmlRenderer)) {
          return renderHtmlInlineNode(
            node,
            children,
            undefined,
            key,
            textValue,
            urlTransform,
            registry?.hasElementFilters() ? (el, ctx, renderElement, renderChildren) => registry.filterElement(el, ctx, renderElement, renderChildren) : undefined,
            parentTagName,
            registry
              ? (tagName, properties, nativeView, htmlChildren, presentationKey) =>
                  registry.renderHtmlPresentation(
                    tagName,
                    properties,
                    nativeView,
                    htmlChildren,
                    presentationKey,
                    animationContext?.nodeKeyPrefix,
                    animationContext?.isFinalized,
                  )
              : undefined,
            (tagName, properties, htmlChildren, presentationKey) =>
              React.createElement(htmlRenderer, {
                ...node,
                key: presentationKey,
                children: htmlChildren,
                textValue,
                properties,
              }),
          );
        }
        return renderHtmlInlineNode(
          node,
          children,
          undefined,
          key,
          textValue,
          urlTransform,
          registry?.hasElementFilters() ? (el, ctx, renderElement, renderChildren) => registry.filterElement(el, ctx, renderElement, renderChildren) : undefined,
          parentTagName,
          registry
            ? (tagName, properties, nativeView, htmlChildren, presentationKey) =>
                registry.renderHtmlPresentation(
                  tagName,
                  properties,
                  nativeView,
                  htmlChildren,
                  presentationKey,
                  animationContext?.nodeKeyPrefix,
                  animationContext?.isFinalized,
                )
            : undefined,
        );
      }
      default: {
        const component = components[node.kind];
        if (component) {
          const engine = node.kind === "math-inline" || node.kind === "math-display"
            ? registry?.getMathEngine()
            : undefined;
          return presentInline(React.createElement(component, { key, ...node, ...(engine ? { engine } : {}) }));
        }
        return presentInline(React.createElement(React.Fragment, { key }, null));
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

  link: ({ href, title, children }) => {
    const safeHref = href == null ? undefined : defaultUrlTransform(href, "href", { source: "markdown" });
    return React.createElement(
      "a",
      {
        ...(safeHref != null ? { href: safeHref } : {}),
        title,
        className: "markdown-link",
        target: safeHref?.startsWith("http") ? "_blank" : undefined,
        rel: safeHref?.startsWith("http") ? "noopener noreferrer" : undefined,
      },
      children,
    );
  },

  image: ({ src, alt, title }) => {
    const safeSrc = defaultUrlTransform(src ?? "", "src", { source: "markdown" });
    return React.createElement("img", {
      ...(safeSrc != null ? { src: safeSrc } : {}),
      alt,
      title,
      className: "markdown-image",
    });
  },

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

  "math-inline": ({ tex, engine }: { tex: string; engine?: MathEngine }) =>
    React.createElement(KaTeXInlineMath, { tex, engine }),

  "math-display": ({ tex, engine }: { tex: string; engine?: MathEngine }) =>
    React.createElement(KaTeXBlockMath, { tex, engine }),

  // Footnote inline reference (superscript anchor)
  "footnote-ref": ({ label, number, occurrence, defined }: { label: string; number?: number; occurrence?: number; defined?: boolean }) => {
    if (!number || defined === false) return React.createElement(React.Fragment, null, `[^${label}]`);
    const n = number;
    const href = `#fn:${n}`;
    const id = `fnref:${n}${occurrence && occurrence > 1 ? `:${occurrence}` : ""}`;
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
type DefaultBlockComponents = {
  paragraph: React.FC<{ inlines: InlineNode[]; raw?: string; meta?: Record<string, unknown>; children?: React.ReactNode } & PresentationProps>;
  heading: React.FC<{ level: 1 | 2 | 3 | 4 | 5 | 6; inlines: InlineNode[]; text?: string; meta?: Record<string, unknown>; children?: React.ReactNode } & PresentationProps>;
  code: React.FC<{
    html?: string;
    meta?: Record<string, unknown>;
    lines?: ReadonlyArray<{ id: string; index: number; text: string; html?: string | null }>;
    lang?: string;
    preAttrs?: Record<string, string>;
    codeAttrs?: Record<string, string>;
    children?: React.ReactNode;
  }>;
  blockquote: React.FC<{ inlines: InlineNode[]; renderedContent?: React.ReactNode }>;
  list: React.FC<{ ordered: boolean; items: InlineNode[][] }>;
  html: React.FC<{ __trustedHtml: TrustedHTML | string; elements?: Record<string, GenericComponent>; isSanitized?: boolean; literalTagContent?: string[]; children?: React.ReactNode }>;
  mdx: React.FC<{ raw?: string; meta?: Record<string, unknown> }>;
  hr: React.FC<React.HTMLAttributes<HTMLHRElement>>;
  table: React.FC<{ header?: InlineNode[][]; rows: InlineNode[][][]; align?: Array<"left" | "center" | "right" | null>; elements?: Partial<TableElements> }>;
  footnotes: React.FC<{ items: FootnoteItem[] }>;
  "footnote-def": React.FC;
  callout: React.FC<{ kind?: string; inlines?: InlineNode[] }>;
};

function blockPresentationProps(props: object): PresentationProps | undefined {
  const decoration: Record<string, unknown> = {};
  for (const [property, value] of Object.entries(props)) {
    if (
      property === "className" ||
      property === "style" ||
      property === "title" ||
      property.startsWith("data-") ||
      property.startsWith("aria-")
    ) {
      decoration[property] = value;
    }
  }
  return Object.keys(decoration).length > 0 ? decoration as PresentationProps : undefined;
}

function applyBlockPresentationProps(
  nativeView: React.ReactNode,
  decoration: PresentationProps | undefined,
): React.ReactNode {
  if (!decoration) return nativeView;
  if (Array.isArray(nativeView)) {
    return nativeView.map((child) => applyBlockPresentationProps(child, decoration));
  }
  if (!React.isValidElement(nativeView)) return nativeView;
  if (nativeView.type === React.Fragment) {
    const children = React.Children.map(nativeView.props.children, (child) =>
      applyBlockPresentationProps(child, decoration),
    );
    return React.cloneElement(nativeView, undefined, children);
  }
  return React.cloneElement(
    nativeView,
    mergeNodePresentationProps(nativeView.props as Record<string, unknown>, decoration),
  );
}
const defaultBlockComponents: DefaultBlockComponents = {
  paragraph: (props) => {
    const { inlines, raw, meta, children } = props;
    const decoration = blockPresentationProps(props);
    if (children !== undefined) {
      return applyBlockPresentationProps(
        React.createElement("p", { className: "markdown-paragraph" }, children),
        decoration,
      );
    }

    const segments = Array.isArray((meta as { mixedSegments?: MixedContentSegment[] } | undefined)?.mixedSegments)
      ? ((meta as { mixedSegments?: MixedContentSegment[] })?.mixedSegments as MixedContentSegment[])
      : undefined;
    if (segments && segments.length > 0) {
      const structured = renderParagraphMixedSegments(segments, defaultInlineComponents, DEFAULT_INLINE_HTML_RENDERERS);
      if (structured.length === 1) {
        return applyBlockPresentationProps(structured[0], decoration);
      }
      return applyBlockPresentationProps(
        React.createElement(React.Fragment, {}, ...structured),
        decoration,
      );
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
    return applyBlockPresentationProps(
      React.createElement(
        "p",
        { className: "markdown-paragraph" },
        effectiveInlines.length > 0 ? renderInlineNodes(effectiveInlines, defaultInlineComponents) : (raw ?? ""),
      ),
      decoration,
    );
  },

  heading: (props) => {
    const { level, inlines, text, meta, children } = props;
    const decoration = blockPresentationProps(props);
    const tag = `h${level}` as keyof JSX.IntrinsicElements;
    const onlyPlainText = Array.isArray(inlines) && inlines.length > 0 && inlines.every((node) => node.kind === "text");
    const content =
      children !== undefined
        ? children
        : onlyPlainText
          ? inlines.map((node) => (node.kind === "text" ? node.text : "")).join("")
          : renderInlineNodes(inlines, defaultInlineComponents);
    const headingId = typeof meta?.headingId === "string" && meta.headingId.length > 0 ? meta.headingId : undefined;
    return applyBlockPresentationProps(
      React.createElement(
        tag,
        {
          className: `markdown-heading markdown-h${level}`,
          ...(text ? { "data-heading-text": text } : {}),
          ...(headingId ? { id: headingId, "data-heading-id": headingId } : {}),
        },
        content,
      ),
      decoration,
    );
  },


  code: ({ html, meta, lines, children, lang, preAttrs, codeAttrs }) => {
    const rawLanguage = typeof lang === "string" ? lang : typeof meta?.lang === "string" ? String(meta.lang) : "";
    const language = rawLanguage.trim();
    if (children !== undefined) {
      const preAttributes = attrsToProps(preAttrs);
      const codeAttributes = attrsToProps(codeAttrs);
      const preClassName = [preAttributes.className, "markdown-code-block", language ? `language-${language}` : ""]
        .filter(Boolean)
        .join(" ");
      const codeClassName = [codeAttributes.className, language ? `language-${language}` : ""]
        .filter(Boolean)
        .join(" ");
      return React.createElement(
        "div",
        { className: language ? `markdown-code-block language-${language}` : "markdown-code-block" },
        React.createElement(
          "pre",
          {
            ...preAttributes,
            className: preClassName,
          },
          React.createElement(
            "code",
            {
              ...codeAttributes,
              ...(codeClassName ? { className: codeClassName } : {}),
            },
            children,
          ),
        ),
      );
    }
    if (html) {
      return React.createElement("div", {
        className: language ? `markdown-code-block language-${language}` : "markdown-code-block",
        /* biome-ignore lint/security/noDangerouslySetInnerHtml: highlighted HTML is generated by our sanitizer */
        dangerouslySetInnerHTML: { __html: html },
      });
    }

    // Fallback for non-highlighted code
    const code = meta?.code || "";
    if (lines && lines.length > 0) {
      const preAttributes = attrsToProps(preAttrs);
      const codeAttributes = attrsToProps(codeAttrs);
      const preClassName = [preAttributes.className, "markdown-code-block", language ? `language-${language}` : ""]
        .filter(Boolean)
        .join(" ");
      const codeClassName = [codeAttributes.className, language ? `language-${language}` : ""]
        .filter(Boolean)
        .join(" ");
      return React.createElement(
        "pre",
        {
          ...preAttributes,
          className: preClassName,
        },
        React.createElement(
          "code",
          {
            ...codeAttributes,
            ...(codeClassName ? { className: codeClassName } : {}),
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
      className: language ? `markdown-code-block language-${language}` : "markdown-code-block",
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

  html: ({ __trustedHtml, elements, isSanitized, literalTagContent, children }) => {
    if (children !== undefined) {
      return React.createElement("div", { className: "markdown-html" }, children);
    }
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

  mdx: ({ raw, meta }) => {
    const originalType = typeof meta?.originalType === "string" ? String(meta.originalType) : undefined;
    const mixedSegments = Array.isArray((meta as { mixedSegments?: MixedContentSegment[] } | undefined)?.mixedSegments)
      ? ((meta as { mixedSegments?: MixedContentSegment[] }).mixedSegments as MixedContentSegment[])
      : undefined;
    if (originalType === "paragraph" && !meta?.mdxStandalone && mixedSegments && mixedSegments.length > 0) {
      const structured = renderParagraphMixedSegments(mixedSegments, defaultInlineComponents, DEFAULT_INLINE_HTML_RENDERERS);
      if (structured.length === 1) {
        return structured[0];
      }
      return React.createElement(React.Fragment, {}, ...structured);
    }
    const diagnostic = "MDX requires explicit engines.mdx in trusted-mdx mode";
    return React.createElement(
      "div",
      { className: "markdown-mdx-inert", "data-diagnostic": diagnostic },
      React.createElement("pre", null, React.createElement("code", null, raw ?? "")),
    );
  },

  // Footnotes block rendered at page end
  footnotes: ({ items }: { items: FootnoteItem[] }) => {
    if (!items || items.length === 0) return React.createElement(React.Fragment, null);

    const listItems = items.map((item) =>
      React.createElement(
        "li",
        { key: item.number, id: `fn:${item.number}` },
        renderInlineNodes(item.inlines, defaultInlineComponents),
        ...Array.from({ length: item.refCount ?? 1 }, (_, index) => React.createElement(
          React.Fragment,
          { key: index },
          " ",
          React.createElement(
            "a",
            {
              href: `#fnref:${item.number}${index > 0 ? `:${index + 1}` : ""}`,
              className: "footnote-backref",
              "aria-label": index > 0 ? `Back to content (reference ${index + 1})` : "Back to content",
              style: { color: "var(--foreground)", textDecoration: "underline" },
            },
            "↩",
            index > 0 ? React.createElement("sup", null, String(index + 1)) : null,
          ),
        )),
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
      rows && rows.length > 0
        ? React.createElement(
            El.Tbody,
            {},
            rows.map((row, r) => React.createElement(El.Tr, { key: r }, renderCells(row, "td", r))),
          )
        : null,
    );
  },
};

/**
 * Component registry that allows customization
 */
export class ComponentRegistry {
  private nodePresentations: NodePresentations = {};
  private inlineComponents: InlineComponents;
  private htmlElements: HtmlElements;
  private defaultHtmlInlineRenderer: InlineComponents["html"] | undefined;
  private tableElements: TableElements;
  private literalTagContent?: string[];
  private contentComponents?: ContentComponentsMap;
  private mathEngine?: MathEngine;
  private tableVirtualization: TableVirtualizationConfig = DEFAULT_TABLE_VIRTUALIZATION_CONFIG;
  private tableVirtualizationListeners = new Set<() => void>();
  private codeVirtualization: VirtualizedCodeConfig = DEFAULT_VIRTUALIZED_CODE_CONFIG;
  private codeVirtualizationListeners = new Set<() => void>();
  private inlineComponentMapCache: InlineComponents | null = null;
  private urlTransform?: UrlTransform;
  private controls: ControlsConfig = false;
  private controlsComponent?: React.ComponentType<ControlsComponentProps>;
  private animated?: AnimatedProp;
  private animatedOptions: ResolvedAnimatedOptions | null = null;
  private animationTimeline: AnimationTimeline | null = null;
  private allowedElements?: ReadonlySet<string>;
  private disallowedElements?: ReadonlySet<string>;
  private allowElement?: AllowElementFn;
  private unwrapDisallowed?: boolean;
  private disableAutolinkProtocols?: ReadonlySet<string>;
  private hasFilterConfig = false;

  constructor(options?: {
    tableVirtualization?: TableVirtualizationOptions;
    codeVirtualization?: Partial<VirtualizedCodeConfig>;
    urlTransform?: UrlTransform;
    controls?: ControlsConfig;
    controlsComponent?: React.ComponentType<ControlsComponentProps>;
    animated?: AnimatedProp;
    contentComponents?: ContentComponentsMap;
    components?: NodePresentations;
    engines?: { math?: MathEngine };
  } & ElementFilterOptions) {
    this.mathEngine = options?.engines?.math;
    this.inlineComponents = { ...defaultInlineComponents };
    this.htmlElements = getDefaultHtmlElements();
    if (options?.urlTransform) {
      this.urlTransform = options.urlTransform;
    }
    if (options?.contentComponents) {
      this.contentComponents = options.contentComponents;
    }
    const defaultHtmlInlineRenderer: InlineComponents["html"] = (
      node: Omit<Extract<InlineNode, { kind: "html" }>, "children"> & { children?: React.ReactNode; textValue?: string },
    ) => renderHtmlInlineNode(node, node.children, this.htmlElements, undefined, node.textValue, this.urlTransform);
    this.defaultHtmlInlineRenderer = defaultHtmlInlineRenderer;
    this.inlineComponents.html = defaultHtmlInlineRenderer;
    this.tableElements = getDefaultTableElements();
    this.setNodePresentations(options?.components);
    if (options?.tableVirtualization !== undefined) {
      this.setTableVirtualization(options.tableVirtualization);
    }
    if (options?.codeVirtualization !== undefined) {
      this.setCodeVirtualization(options.codeVirtualization);
    }
    if (options?.controls !== undefined) {
      this.setControls(options.controls);
    }
    if (options?.controlsComponent !== undefined) {
      this.setControlsComponent(options.controlsComponent);
    }
    if (options?.animated !== undefined) {
      this.setAnimated(options.animated);
    }
    if (options) {
      this.setElementFilters(options);
    }
  }
  setLinkSafetyRenderer(renderer?: InlineComponents["link"]): void {
    this.inlineComponents = {
      ...this.inlineComponents,
      link: renderer ?? defaultInlineComponents.link,
    } as InlineComponents;
    this.inlineComponentMapCache = null;
  }

  hasElementFilters(): boolean {
    return this.hasFilterConfig;
  }

  /** Replaces the whole filter configuration at once so prop swaps (allowed -> disallowed) never trip the exclusivity check. */
  setElementFilters(options: ElementFilterOptions): void {
    const { allowedElements, disallowedElements, allowElement, unwrapDisallowed, disableAutolinkProtocols } = options;
    if (allowedElements && disallowedElements) {
      throw new Error("Cannot specify both allowedElements and disallowedElements; expected one or the other");
    }
    const toTagSet = (tags?: string[]) => (tags ? new Set(tags.map((tag) => tag.trim().toLowerCase())) : undefined);
    this.allowedElements = toTagSet(allowedElements);
    this.disallowedElements = toTagSet(disallowedElements);
    this.allowElement = allowElement;
    this.unwrapDisallowed = unwrapDisallowed;
    this.disableAutolinkProtocols = disableAutolinkProtocols
      ? new Set(disableAutolinkProtocols.map((protocol) => protocol.trim().toLowerCase().replace(/:$/, "")))
      : undefined;
    this.hasFilterConfig = Boolean(this.allowedElements || this.disallowedElements || this.allowElement);
  }

  isAutolinkProtocolDisabled(href?: string): boolean {
    if (!this.disableAutolinkProtocols || !href) return false;
    const match = /^[a-zA-Z][a-zA-Z0-9+.-]*(?=:)/.exec(href.trim());
    if (!match) return false;
    return this.disableAutolinkProtocols.has(match[0].toLowerCase());
  }

  isElementAllowed(
    element: ElementFilterDescriptor,
    context: ElementFilterContext,
  ): boolean {
    const tag = element.tagName.toLowerCase();
    if (this.allowedElements && !this.allowedElements.has(tag)) {
      return false;
    }
    if (this.disallowedElements && this.disallowedElements.has(tag)) {
      return false;
    }
    if (this.allowElement) {
      const allowed = this.allowElement(
        { tagName: tag, properties: element.properties ?? {}, blockType: element.blockType },
        context,
      );
      if (!allowed) {
        return false;
      }
    }
    return true;
  }

  filterElement(
    element: ElementFilterDescriptor,
    context: ElementFilterContext,
    renderElement: () => React.ReactNode,
    renderChildren?: () => React.ReactNode,
  ): React.ReactNode {
    if (!this.hasFilterConfig) {
      return renderElement();
    }
    if (this.isElementAllowed(element, context)) {
      return renderElement();
    }
    if (this.unwrapDisallowed && renderChildren) {
      const children = renderChildren();
      if (children === undefined || children === null) return null;
      const key = element.properties?.key as string | number | undefined;
      return React.createElement(React.Fragment, key !== undefined ? { key } : null, children);
    }
    return null;
  }



  setUrlTransform(transform?: UrlTransform): void {
    this.urlTransform = transform;
  }

  setAnimated(animated?: AnimatedProp): void {
    this.animated = animated;
    this.animatedOptions = resolveAnimatedOptions(animated);
    if (this.animatedOptions) {
      if (!this.animationTimeline) {
        this.animationTimeline = new AnimationTimeline({
          maxBacklogMs: this.animatedOptions.maxBacklogMs,
          stagger: this.animatedOptions.stagger,
        });
      } else {
        this.animationTimeline.updateOptions({
          maxBacklogMs: this.animatedOptions.maxBacklogMs,
          stagger: this.animatedOptions.stagger,
        });
      }
    } else {
      if (this.animationTimeline) {
        this.animationTimeline.reset();
      }
      this.animationTimeline = null;
    }
  }

  getAnimated(): AnimatedProp | undefined {
    return this.animated;
  }

  getAnimatedOptions(): ResolvedAnimatedOptions | null {
    return this.animatedOptions;
  }

  getAnimationTimeline(): AnimationTimeline | null {
    return this.animationTimeline;
  }

  getRenderInlineContext(isFinalized?: boolean, blockId?: string): RenderInlineAnimationContext | undefined {
    if (isFinalized) {
      if (blockId && this.animationTimeline) {
        this.animationTimeline.releasePrefix(blockId);
      }
      return { isFinalized: true, nodeKeyPrefix: blockId };
    }
    if (!this.animatedOptions || !this.animationTimeline) {
      return undefined;
    }
    return {
      isFinalized: false,
      animated: this.animatedOptions,
      timeline: this.animationTimeline,
      nodeKeyPrefix: blockId,
    };
  }

  resetAnimationTimeline(): void {
    this.animationTimeline?.reset();
  }

  getUrlTransform(): UrlTransform | undefined {
    return this.urlTransform;
  }


  releaseFinalizedBlockAnimations(blockId: string): void {
    this.animationTimeline?.releasePrefix(blockId);
  }


  setNodePresentations(presentations?: NodePresentations): void {
    validateNodePresentations(presentations);
    this.nodePresentations = presentations ?? {};
  }

  getNodePresentation<K extends keyof NodePresentations & string>(key: K): NodePresentations[K] | undefined {
    return resolveNodePresentation(this.nodePresentations, key);
  }

  isDefaultHtmlInlineRenderer(renderer: InlineComponents["html"] | undefined): boolean {
    if (!renderer || !this.defaultHtmlInlineRenderer) {
      return false;
    }
    return renderer === this.defaultHtmlInlineRenderer;
  }

  renderInlinePresentation(
    node: InlineNode,
    nativeView: React.ReactNode,
    key: React.Key,
    context?: RenderInlineAnimationContext,
    renderedChildren?: React.ReactNode,
  ): React.ReactNode {
    const keyName = (
      node.kind === "plugin"
        ? `extension:${node.name}`
        : node.kind === "math-inline" || node.kind === "math-display"
          ? "inline:math"
          : `inline:${node.kind}`
    ) as `inline:${string}` | `extension:${string}`;
    const presentation = this.getNodePresentation(keyName);
    if (!presentation) return nativeView;
    const hasPluginComponent = node.kind === "plugin" &&
      (this.inlineComponents[node.name] !== undefined || this.inlineComponents.plugin !== undefined);
    const preparedNativeView = node.kind === "plugin" && !hasPluginComponent && renderedChildren !== undefined
      ? React.createElement(React.Fragment, { key }, renderedChildren)
      : nativeView;
    let presentedNode = node;
    if ("view" in presentation && presentation.view) {
      const transform = this.urlTransform ?? defaultUrlTransform;
      if (node.kind === "link") {
        presentedNode = {
          ...node,
          href: transform(node.href ?? "", "href", { source: "markdown" }) ?? undefined,
        };
      } else if (node.kind === "image") {
        presentedNode = {
          ...node,
          src: transform(node.src ?? "", "src", { source: "markdown" }) ?? "",
        };
      }
    }
    const metadata: NodeViewMetadata = Object.freeze({
      id: `${context?.nodeKeyPrefix ?? "inline"}:${String(key)}`,
      type: keyName,
      isFinalized: context?.isFinalized ?? false,
    });
    const source = () => inlineToPlainText([node]);
    const actions: NodeViewActions = Object.freeze({
      copy: () => copyToClipboard(source()),
      download: () => downloadFile(source(), `${node.kind}.txt`),
    });
    const children = node.kind === "math-inline" || node.kind === "math-display"
      ? nativeView
      : renderedChildren ?? (React.isValidElement<{ children?: React.ReactNode }>(preparedNativeView)
        ? preparedNativeView.props.children
        : undefined);
    return renderPresentedNode<`inline:${string}` | `extension:${string}`>(presentation, preparedNativeView, {
      key,
      metadata,
      actions,
      viewProps: { node: presentedNode, children, metadata, actions },
    });
  }

  renderHtmlPresentation(
    tagName: string,
    properties: Readonly<Record<string, unknown>>,
    nativeView: React.ReactNode,
    children: React.ReactNode,
    key: React.Key,
    ownerId?: string,
    isFinalized = false,
  ): React.ReactNode {
    const keyName = `html:${tagName.toLowerCase()}` as `html:${string}`;
    const presentation = this.getNodePresentation(keyName);
    if (!presentation) return nativeView;
    const viewProperties: Record<string, unknown> = {};
    for (const [property, value] of Object.entries(properties)) {
      if (property !== "key") {
        viewProperties[property] = value;
      }
    }
    const source = () => presentationText(children);
    const metadata: NodeViewMetadata = Object.freeze({
      id: `${ownerId ?? "html"}:${String(key)}`,
      type: keyName,
      isFinalized,
    });
    const actions: NodeViewActions = Object.freeze({
      copy: () => copyToClipboard(source()),
      download: () => downloadFile(source(), `${tagName.toLowerCase()}.txt`),
    });
    return renderPresentedNode<`html:${string}`>(presentation, nativeView, {
      key,
      metadata,
      actions,
      viewProps: { tagName: tagName.toLowerCase(), properties: viewProperties, children, metadata, actions },
    });
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

  setControls(controls?: ControlsConfig): void {
    this.controls = controls ?? false;
  }

  getControls(): ControlsConfig {
    return this.controls;
  }

  setControlsComponent(component?: React.ComponentType<ControlsComponentProps>): void {
    this.controlsComponent = component;
  }

  getControlsComponent(): React.ComponentType<ControlsComponentProps> | undefined {
    if (this.controlsComponent) {
      return this.controlsComponent;
    }
    return undefined;
  }


  /**
   * Get block component
   */
  getBlockComponent(type: string): GenericComponent {
    return defaultBlockComponents[type as keyof DefaultBlockComponents] ?? defaultBlockComponents.paragraph;
  }
  getCodeNodeView(): React.ComponentType<CodeNodeViewProps> | undefined {
    const presentation = this.getNodePresentation("code");
    return presentation && "view" in presentation ? presentation.view : undefined;
  }

  /**
   * Get inline components
   */
  getInlineComponents(): InlineComponents {
    return this.inlineComponents;
  }

  getMathEngine(): MathEngine | undefined {
    return this.mathEngine;
  }
  setContentComponents(contentComponents?: ContentComponentsMap): void {
    this.contentComponents = contentComponents;
  }

  getContentComponents(): ContentComponentsMap | undefined {
    return this.contentComponents;
  }


  renderHtmlTree(
    tree: HtmlTreeNode[],
    renderBlock: (block: Block, parentTagName?: string) => React.ReactNode = (block) => this.renderBlock(block),
    paragraph?: Block,
    parentTagName?: string,
    renderParagraphPresentation?: (nativeView: React.ReactNode) => React.ReactNode,
  ): React.ReactNode {
    return renderOwnedHtmlTree(
      tree,
      this.ownedHtmlRenderContext(renderBlock, paragraph, parentTagName, undefined, renderParagraphPresentation),
    );
  }

  private ownedHtmlRenderContext(
    renderBlock: (block: Block, parentTagName?: string) => React.ReactNode = (block) => this.renderBlock(block),
    paragraph?: Block,
    parentTagName?: string,
    inlineContext?: RenderInlineAnimationContext,
    renderParagraphPresentation?: (nativeView: React.ReactNode) => React.ReactNode,
  ): OwnedHtmlRenderContext {
    const renderContext = inlineContext ?? (paragraph
      ? this.getRenderInlineContext(paragraph.isFinalized, paragraph.id)
      : undefined);
    return {
      elements: this.htmlElements,
      renderBlock,
      renderInline: (nodes, parentTagName) =>
        renderInlineNodes(nodes, this.inlineComponents, this.urlTransform, this, parentTagName, renderContext),
      renderInlinePresentation: (node, nativeView, key, children) =>
        this.renderInlinePresentation(node, nativeView, key, renderContext, children),
      renderHtmlPresentation: (tagName, properties, nativeView, children, key) =>
        this.renderHtmlPresentation(
          tagName,
          properties,
          nativeView,
          children,
          key,
          renderContext?.nodeKeyPrefix ?? String(paragraph?.id ?? parentTagName ?? "html"),
          renderContext?.isFinalized ?? paragraph?.isFinalized ?? false,
        ),
      inlineComponents: this.inlineComponents,
      urlTransform: this.urlTransform,
      isAutolinkProtocolDisabled: (href) => this.isAutolinkProtocolDisabled(href),
      filterElement: this.hasElementFilters()
        ? (element, context, renderElement, renderChildren) => this.filterElement(element, context, renderElement, renderChildren)
        : undefined,
      parentTagName,
      contentComponents: this.contentComponents,
      renderParagraph: paragraph ? (children) => {
        const nativeView = React.createElement(this.getBlockComponent("paragraph"), {
          ...this.getBlockProps(paragraph), children,
        });
        return renderParagraphPresentation ? renderParagraphPresentation(nativeView) : nativeView;
      } : undefined,
    };
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

  subscribeCodeVirtualization(listener: () => void): () => void {
    this.codeVirtualizationListeners.add(listener);
    return () => {
      this.codeVirtualizationListeners.delete(listener);
    };
  }

  setCodeVirtualization(options: Partial<VirtualizedCodeConfig> | undefined): void {
    this.codeVirtualization = resolveVirtualizedCodeConfig(options);
    for (const listener of this.codeVirtualizationListeners) {
      listener();
    }
  }

  getCodeVirtualization(): VirtualizedCodeConfig {
    return this.codeVirtualization;
  }

  /**
   * Render a block
   */
  renderBlock(
    block: Block,
    renderPresentation?: (nativeView: React.ReactNode) => React.ReactNode,
  ): React.ReactElement {
    const meta = block.payload.meta;
    const sourceOwnedHtmlTree = meta?.htmlOwnership === true && Array.isArray(meta.htmlTree) ? meta.htmlTree : undefined;
    if (block.type === "paragraph" && sourceOwnedHtmlTree) {
      return React.createElement(
        React.Fragment,
        {},
        this.renderHtmlTree(sourceOwnedHtmlTree, undefined, block, undefined, renderPresentation),
      );
    }
    if (block.type === "paragraph" && meta?.htmlParagraphTree) {
      return React.createElement(
        React.Fragment,
        {},
        this.renderHtmlTree(meta.htmlParagraphTree, undefined, block, undefined, renderPresentation),
      );
    }
    const Component = this.getBlockComponent(block.type);
    const props = this.getBlockProps(block);
    const paragraphGroups = block.type === "paragraph" &&
      Array.isArray(block.payload.meta?.mixedSegments) && Array.isArray(props.children)
      ? props.children as React.ReactNode[]
      : undefined;
    if (paragraphGroups) {
      props.children = paragraphGroups.flatMap((group) =>
        React.isValidElement<{ children?: React.ReactNode }>(group) && group.type === "p"
          ? React.Children.toArray(group.props.children)
          : [group],
      );
    }
    const element = paragraphGroups
      ? React.createElement(React.Fragment, { key: block.id }, ...paragraphGroups.map((group, index) =>
          React.isValidElement<{ children?: React.ReactNode }>(group) && group.type === "p"
            ? React.createElement(Component, { ...props, key: `${block.id}-${index}`, children: group.props.children })
            : group,
        ))
      : React.createElement(Component, { key: block.id, ...props });

    const finalElement = (() => {
      if (block.type === "code") {
        const meta = (block.payload.meta ?? {}) as Record<string, unknown>;
        const lang = typeof meta.lang === "string" ? String(meta.lang) : "";
        const raw = typeof block.payload.raw === "string" ? block.payload.raw : "";
        const metaCode = typeof meta.code === "string" ? (meta.code as string) : null;
        const normalizedRaw = raw.replace(/\r\n?/g, "\n");
        const fenced = stripCodeFence(block.isFinalized ? normalizedRaw : trimProvisionalFenceTail(normalizedRaw));
        const codeText = metaCode !== null ? metaCode.replace(/\r\n?/g, "\n") : (fenced.hadFence ? fenced.code : normalizedRaw);
        const codeControls = resolveCodeControls(this.getControls());
        if (Array.isArray(meta.diffBlocks) && meta.diffBlocks.length > 0) {
          return React.createElement(DefaultDiffRenderer, {
            key: block.id,
            meta,
            renderCode: element,
          });
        }
        if (codeControls.enabled) {
          const ControlsComponent = this.getControlsComponent();
          const controlsElement = ControlsComponent ? (
            React.createElement(ControlsComponent, {
              type: "code",
              blockId: block.id,
              code: codeText,
              language: lang,
              isFinalized: block.isFinalized,
              onCopy: () => copyToClipboard(codeText),
              onDownload: () => downloadFile(codeText, getCodeSnippetFilename(lang)),
              labels: codeControls.labels,
            })
          ) : (
            React.createElement(CodeControlsBar, {
              code: codeText,
              language: lang,
              config: codeControls,
            })
          );
          return React.createElement("div", { className: "stream-mdx-code-wrapper relative", key: block.id }, controlsElement, element);
        }
      }

      if (block.type === "table") {
        const tableControls = resolveTableControls(this.getControls());
        if (tableControls.enabled) {
          const meta = (block.payload.meta ?? {}) as Record<string, unknown>;
          const header = Array.isArray(meta.header) ? (meta.header as InlineNode[][]).map((cell) => inlineToPlainText(cell)) : [];
          const rows = Array.isArray(meta.rows) ? (meta.rows as InlineNode[][][]).map((r) => r.map((cell) => inlineToPlainText(cell))) : [];
          const align = Array.isArray(meta.align) ? (meta.align as Array<"left" | "center" | "right" | null>) : undefined;
          const isFinalized = Boolean(block.isFinalized);
          const ControlsComponent = this.getControlsComponent();
          const controlsElement = ControlsComponent ? (
            React.createElement(ControlsComponent, {
              type: "table",
              blockId: block.id,
              headers: header,
              rows,
              align,
              isFinalized,
              onCopy: (format) => {
                if (!isFinalized) return;
                const text = format === "markdown" ? tableToMarkdown(header, rows, align) : tableToTsv(header, rows);
                return copyToClipboard(text);
              },
              onDownload: (format) => {
                if (!isFinalized) return;
                if (format === "tsv") downloadFile(tableToTsv(header, rows), "table.tsv", "text/tab-separated-values;charset=utf-8");
                else if (format === "markdown") downloadFile(tableToMarkdown(header, rows, align), "table.md", "text/markdown;charset=utf-8");
                else downloadFile(tableToCsv(header, rows), "table.csv", "text/csv;charset=utf-8");
              },
              labels: tableControls.labels,
            })
          ) : (
            React.createElement(TableControlsBar, {
              headers: header,
              rows,
              align,
              isFinalized,
              config: tableControls,
            })
          );
          return React.createElement("div", { className: "stream-mdx-table-wrapper relative", key: block.id }, controlsElement, element);
        }
      }
      return element;
    })();

    if (this.hasFilterConfig) {
      let blockTagName = "";
      switch (block.type) {
        case "paragraph":
          blockTagName = "p";
          break;
        case "heading": {
          const meta = (block.payload.meta ?? {}) as Record<string, unknown>;
          const levelFromMeta = typeof meta.headingLevel === "number" ? meta.headingLevel : undefined;
          const normalizedLevel = Number.isFinite(levelFromMeta) ? Math.min(Math.max(levelFromMeta as number, 1), 6) : undefined;
          const rawHeading = typeof block.payload.raw === "string" ? block.payload.raw : "";
          const level = normalizedLevel ?? this.extractHeadingLevel(rawHeading);
          blockTagName = `h${level}`;
          break;
        }
        case "code":
          blockTagName = "pre";
          break;
        case "blockquote":
          blockTagName = "blockquote";
          break;
        case "hr":
          blockTagName = "hr";
          break;
        case "list":
          blockTagName = block.payload.meta?.ordered ? "ol" : "ul";
          break;
        case "table":
          blockTagName = "table";
          break;
      }
      if (blockTagName) {
        const renderChildren = () => {
          if (block.type === "paragraph" || block.type === "heading") {
            return "children" in props ? (props.children as React.ReactNode) : undefined;
          }
          if (block.type === "blockquote") {
            return "renderedContent" in props ? (props.renderedContent as React.ReactNode) : undefined;
          }
          if (block.type === "code") {
            const meta = block.payload.meta;
            const metaCode = meta && typeof meta === "object" && "code" in meta && typeof meta.code === "string" ? meta.code : undefined;
            return metaCode || block.payload.raw || "";
          }
          return undefined;
        };
        const filtered = this.filterElement(
          { tagName: blockTagName, properties: props, blockType: block.type },
          { source: "markdown" },
          () => renderPresentation ? renderPresentation(finalElement) : finalElement,
          renderChildren,
        );
        if (filtered === null || filtered === undefined) {
          return React.createElement(React.Fragment, { key: block.id });
        }
        return React.isValidElement(filtered) ? filtered : React.createElement(React.Fragment, { key: block.id }, filtered);
      }
    }

    const presented = renderPresentation ? renderPresentation(finalElement) : finalElement;
    return React.isValidElement(presented)
      ? presented
      : React.createElement(React.Fragment, { key: block.id }, presented);
  }

  /**
   * Get props for a block based on its type
   */
  private getBlockProps(block: Block): Record<string, unknown> {
    const animCtx = this.getRenderInlineContext(block.isFinalized, block.id);
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
        const ownedTree = block.payload.meta?.htmlOwnership === true ? block.payload.meta.htmlTree : undefined;
        const ownedRoot = ownedTree?.length === 1 ? ownedTree[0] : undefined;
        const ownedChildren = ownedRoot?.kind === "element" && ownedRoot.tagName === `h${level}` ? ownedRoot.children : undefined;
        const renderedChildren = ownedChildren
          ? renderOwnedHtmlTree(ownedChildren, this.ownedHtmlRenderContext(undefined, undefined, `h${level}`, animCtx))
          : renderInlineNodes(inlineNodes, this.inlineComponents, this.urlTransform, this, `h${level}`, animCtx);
        return {
          level,
          inlines: inlineNodes,
          text: headingText,
          meta,
          children: renderedChildren,
        };
      }
      case "paragraph": {
        const segments = block.payload.meta?.mixedSegments;
        return {
          inlines: block.payload.inline || [],
          raw: block.payload.raw,
          meta: block.payload.meta,
          children: Array.isArray(segments) && segments.length > 0
            ? renderMixedParagraphSegments(
                segments, this.inlineComponents, DEFAULT_INLINE_HTML_RENDERERS,
                this.htmlElements, this.literalTagContent, this.urlTransform, this, animCtx,
                block.payload.meta?.mixedHtmlTrees as Record<number, HtmlTreeNode[]> | undefined,
                (tree) => renderOwnedHtmlTree(tree, this.ownedHtmlRenderContext(undefined, undefined, "p", animCtx)),
              )
            : renderInlineNodes(block.payload.inline ?? [], this.inlineComponents, this.urlTransform, this, "p", animCtx),
        };
      }
      case "blockquote":
        return {
          inlines: block.payload.inline || [],
          renderedContent: renderInlineNodes(block.payload.inline || [], this.inlineComponents, this.urlTransform, this, "blockquote", animCtx),
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
        const htmlTree = block.payload.meta?.htmlTree;
        return {
          __trustedHtml: isWorkerSanitized || typeof window === "undefined" ? String(content) : createTrustedHTML(String(content)),
          elements: this.htmlElements,
          isSanitized: isWorkerSanitized,
          literalTagContent: this.literalTagContent,
          children: htmlTree
            ? this.renderHtmlTree(htmlTree, undefined, block)
            : undefined,
        };
      }

      case "mdx":
        return {
          raw: typeof block.payload.raw === "string" ? block.payload.raw : undefined,
          meta: block.payload.meta as Record<string, unknown> | undefined,
        };

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

const DEFAULT_LITERAL_TAGS = new Set(["code", "pre", "script", "style", "textarea"]);

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
  if (tag === "textarea") {
    return React.createElement(elements[tag] ?? tag, { ...props, key, defaultValue: el.textContent ?? "" });
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
    const lower = key.toLowerCase();
    if (isForbiddenAttribute(lower)) {
      continue;
    }
    if (key === "class") {
      result.className = value;
    } else if (key === "style") {
      result.style = parseStyleAttribute(value);
    } else if (key === "tabindex" || key === "tabIndex") {
      const numericValue = Number(value);
      if (!Number.isNaN(numericValue)) {
        result.tabIndex = numericValue;
      }
    } else if (lower === "href") {
      const safe = defaultUrlTransform(value, "href", { source: "html" });
      if (safe != null) result.href = safe;
    } else if (lower === "src") {
      const safe = defaultUrlTransform(value, "src", { source: "html" });
      if (safe != null) result.src = safe;
    } else if (lower === "action") {
      const safe = defaultUrlTransform(value, "href", { source: "html" });
      if (safe != null) result.action = safe;
    } else if (lower === "formaction") {
      const safe = defaultUrlTransform(value, "href", { source: "html" });
      if (safe != null) (result as Record<string, unknown>).formAction = safe;
    } else if (lower === "xlink:href" || lower === "xlinkhref") {
      const safe = defaultUrlTransform(value, "href", { source: "html" });
      if (safe != null) (result as Record<string, unknown>).xlinkHref = safe;
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
    const separator = part.indexOf(":");
    if (separator <= 0) continue;
    const prop = part.slice(0, separator).trim();
    const val = part.slice(separator + 1).trim();
    if (!isSafeStyleDeclaration(prop, val)) continue;
    const cssProperty = prop.startsWith("--")
      ? prop
      : prop.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
    (style as Record<string, string>)[cssProperty] = val;
  }
  return style;
}

export function renderParagraphMixedSegments(
  segments: MixedContentSegment[],
  inlineComponents: InlineComponents,
  inlineHtmlRenderers: InlineHtmlRendererMap,
  htmlElements?: HtmlElements,
  literalTagContent?: string[],
  urlTransform?: UrlTransform,
): React.ReactNode[] {
  return renderMixedParagraphSegments(segments, inlineComponents, inlineHtmlRenderers, htmlElements, literalTagContent, urlTransform);
}

// Registry-owned rendering carries filter and animation context without widening the public helper.
function renderMixedParagraphSegments(
  segments: MixedContentSegment[],
  inlineComponents: InlineComponents,
  inlineHtmlRenderers: InlineHtmlRendererMap,
  htmlElements?: HtmlElements,
  literalTagContent?: string[],
  urlTransform?: UrlTransform,
  registry?: ComponentRegistry,
  animationContext?: RenderInlineAnimationContext,
  htmlTrees?: Record<number, HtmlTreeNode[]>,
  renderOwnedHtml?: (tree: HtmlTreeNode[]) => React.ReactNode,
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
          const rendered = renderInlineNodes(chunkNodes, inlineComponents, urlTransform, registry, "p", animationContext);
          pushRenderedNodes(ensureArray(rendered), inlineBuffer, chunkKey);
        };

        inlineNodes.forEach((inlineNode, inlineIdx) => {
          if (inlineNode.kind === "math-display") {
            pushChunk(chunk, `${key}-chunk-${inlineIdx}`);
            chunk = [];
            flushInline();
            const rendered = renderInlineNodes([inlineNode], inlineComponents, urlTransform, registry, "p", animationContext);
            pushRenderedNodes(ensureArray(rendered), result, `${key}-math-${inlineIdx}`);
          } else {
            chunk.push(inlineNode);
          }
        });

        pushChunk(chunk, `${key}-chunk-tail`);
        break;
      }
      case "mdx": {
        const element = React.createElement("span", { className: "markdown-mdx-inline" }, segment.value);
        inlineBuffer.push(React.createElement(React.Fragment, { key }, element));
        break;
      }
      case "html": {
        const html = segment.sanitized ?? segment.value;
        const isBlockLevel = isBlockLevelHtml(html);
        if (registry && htmlTrees?.[index] !== undefined) {
          const rendered = renderOwnedHtml ? renderOwnedHtml(htmlTrees[index]) : registry.renderHtmlTree(htmlTrees[index]);
          if (isBlockLevel) {
            flushInline();
            pushRenderedNodes(ensureArray(rendered), result, key);
          } else {
            pushRenderedNodes(ensureArray(rendered), inlineBuffer, key);
          }
          break;
        }
        const parseMarkdown = (text: string) => {
          if (!text || (!text.includes("*") && !text.includes("_") && !text.includes("[") && !text.includes("`") && !text.includes("#"))) {
            return text;
          }
          return renderInlineNodes(new InlineParser().parse(text), inlineComponents, urlTransform, registry, "p", animationContext);
        };
        const element = renderInlineHtmlSegment(segment.value, segment.sanitized, {
          key,
          renderers: inlineHtmlRenderers,
          htmlElements,
          literalTagContent,
          urlTransform,
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
        } else if (html) {
          inlineBuffer.push(
            React.createElement("span", {
              key,
              className: "markdown-inline-html",
              dangerouslySetInnerHTML: { __html: html },
            }),
          );
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
