import React from "react";
import { defaultUrlTransform, type Block, type HtmlTreeNode, type InlineNode, type UrlTransform } from "@stream-mdx/core";
import { renderHtmlOwnershipTree } from "../utils/inline-html";
import type { ElementFilterContext, ElementFilterDescriptor, HtmlElements, InlineComponents } from "../types";
import type { ContentComponentsMap } from "./content-components";

export type OwnedHtmlRenderContext = {
  elements: HtmlElements;
  renderBlock: (block: Block, parentTagName?: string) => React.ReactNode;
  renderInline: (nodes: InlineNode[], parentTagName?: string) => React.ReactNode;
  inlineComponents: InlineComponents;
  urlTransform?: UrlTransform;
  isAutolinkProtocolDisabled: (href?: string) => boolean;
  filterElement?: (
    element: ElementFilterDescriptor,
    context: ElementFilterContext,
    renderElement: () => React.ReactNode,
    renderChildren?: () => React.ReactNode,
  ) => React.ReactNode;
  parentTagName?: string;
  contentComponents?: ContentComponentsMap;
  renderParagraph?: (children: React.ReactNode) => React.ReactNode;
  renderInlinePresentation?: (node: InlineNode, nativeView: React.ReactNode, key: React.Key) => React.ReactNode;
  renderHtmlPresentation?: (
    tagName: string,
    properties: Readonly<Record<string, unknown>>,
    nativeView: React.ReactNode,
    children: React.ReactNode,
    key: React.Key,
  ) => React.ReactNode;
};

export function renderOwnedHtmlTree(tree: HtmlTreeNode[], context: OwnedHtmlRenderContext): React.ReactNode {
  return renderHtmlOwnershipTree(
    tree,
    context.elements,
    context.renderBlock,
    context.renderInline,
    (node, children, parentTagName, key) => {
      if (node.kind === "strong" || node.kind === "em" || node.kind === "strike" || node.kind === "link") {
        const component = context.inlineComponents[node.kind];
        const renderElement = () => {
          let direct: React.ReactNode;
          if (node.kind === "link") {
            if (node.autolink && context.isAutolinkProtocolDisabled(node.href)) return children;
            const { href, ...linkProps } = node;
            const transform = context.urlTransform ?? defaultUrlTransform;
            const safeHref = transform(href ?? "", "href", { source: "markdown" });
            direct = component ? React.createElement(component, {
              ...linkProps,
              key,
              ...(safeHref != null ? { href: safeHref } : {}),
              children,
            }) : React.createElement("a", { key, href: safeHref ?? undefined }, children);
          } else {
            const tag = node.kind === "strike" ? "del" : node.kind;
            direct = component
              ? React.createElement(component, { ...node, key, children })
              : React.createElement(tag, { key }, children);
          }
          return context.renderInlinePresentation
            ? context.renderInlinePresentation(node, direct, key)
            : direct;
        };
        if (!context.filterElement) return renderElement();
        const tag = node.kind === "strike" ? "del" : node.kind === "link" ? "a" : node.kind;
        const properties = node.kind === "link"
          ? { href: context.urlTransform?.(node.href ?? "", "href", { source: "markdown" }) ?? node.href, title: node.title }
          : {};
        return context.filterElement(
          { tagName: tag, properties },
          { source: "markdown", parentTagName },
          renderElement,
          () => children,
        );
      }
      if (node.kind === "plugin") {
        const component = context.inlineComponents[node.name] ?? context.inlineComponents.plugin;
        const direct = component
          ? React.createElement(component, { ...node.attrs, key, name: node.name, attrs: node.attrs, raw: node.raw, children })
          : node.raw;
        return context.renderInlinePresentation
          ? context.renderInlinePresentation(node, direct, key)
          : direct;
      }
      return context.renderInline([node], parentTagName);
    },
    context.renderParagraph,
    context.urlTransform,
    context.filterElement,
    context.parentTagName,
    context.contentComponents,
    context.renderHtmlPresentation,
  );
}
