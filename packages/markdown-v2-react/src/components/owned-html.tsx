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
};

export function renderOwnedHtmlTree(tree: HtmlTreeNode[], context: OwnedHtmlRenderContext): React.ReactNode {
  return renderHtmlOwnershipTree(
    tree,
    context.elements,
    context.renderBlock,
    context.renderInline,
    (node, children, parentTagName) => {
      if (node.kind === "strong" || node.kind === "em" || node.kind === "strike" || node.kind === "link") {
        const component = context.inlineComponents[node.kind];
        if (node.kind === "link") {
          if (node.autolink && context.isAutolinkProtocolDisabled(node.href)) return children;
          const { href, ...linkProps } = node;
          const transform = context.urlTransform ?? defaultUrlTransform;
          const safeHref = transform(href ?? "", "href", { source: "markdown" });
          const direct = component ? React.createElement(component, {
            ...linkProps,
            ...(safeHref != null ? { href: safeHref } : {}),
            children,
          }) : React.createElement("a", { href: safeHref ?? undefined }, children);
          if (!context.filterElement) return direct;
          return context.filterElement(
            { tagName: "a", properties: { href: safeHref, title: node.title } },
            { source: "markdown", parentTagName },
            () => direct,
            () => children,
          );
        }
        const tag = node.kind === "strike" ? "del" : node.kind;
        const direct = component ? React.createElement(component, { ...node, children }) : React.createElement(tag, {}, children);
        if (!context.filterElement) return direct;
        return context.filterElement(
          { tagName: tag, properties: {} },
          { source: "markdown", parentTagName },
          () => direct,
          () => children,
        );
      }
      if (node.kind === "plugin") {
        const component = context.inlineComponents[node.name] ?? context.inlineComponents.plugin;
        return component ? React.createElement(component, { ...node.attrs, name: node.name, attrs: node.attrs, raw: node.raw, children }) : node.raw;
      }
      return context.renderInline([node], parentTagName);
    },
    context.renderParagraph,
    context.urlTransform,
    context.filterElement,
    context.parentTagName,
    context.contentComponents,
  );
}
