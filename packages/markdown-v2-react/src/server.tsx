import React from "react";
import { MarkdownBlocksRenderer as BaseMarkdownBlocksRenderer, type MarkdownBlocksRendererProps } from "./renderer/blocks-renderer";

/** Static/SSR output is never animated. */
export const MarkdownBlocksRenderer: React.FC<MarkdownBlocksRendererProps> = (props) =>
  React.createElement(BaseMarkdownBlocksRenderer, { ...props, animated: false });
export type { MarkdownBlocksRendererProps };
export { ComponentRegistry } from "./components";
export { defineContentComponent } from "./components/content-components";
export type {
  BroadContentComponentOptions,
  ContentComponentHostProps,
  ContentComponentProps,
  ContentComponentPropsGuard,
  ContentComponentRegistration,
  ContentComponentsMap,
  ValidatedContentComponentOptions,
} from "./components/content-components";
export { TrustedMdxServerRegionProvider } from "./trusted-mdx/server-regions";
export { createRendererStore } from "./renderer/store";
export { defaultUrlTransform } from "@stream-mdx/core";
export { STREAM_MDX_ANIMATION_CSS, DEFAULT_ANIMATED_OPTIONS } from "./animation";
export type {
  AllowElementFn,
  BlockComponents,
  CodeFenceRenderer,
  CodeFenceRendererConfig,
  CodeFenceRendererProps,
  ElementFilterContext,
  ElementFilterDescriptor,
  ElementFilterOptions,
  HtmlElements,
  InlineComponents,
  InlineHtmlRenderer,
  InlineHtmlRendererMap,
  MathRenderer,
  MathRendererProps,
  RendererConfig,
  TableElements,
  UrlTransform,
  UrlTransformContext,
  ControlsConfig,
  ControlsOptions,
  CodeControlsConfig,
  TableControlsConfig,
  MermaidControlsConfig,
  ControlsLabels,
  ControlsComponentProps,
  TableDownloadFormat,
  TableCopyFormat,
  AnimatedAnimationName,
  AnimatedOptions,
  AnimatedProp,
} from "./types";
export {
  CodeControlsBar,
  TableControlsBar,
  CodeBlockCopyButton,
  CodeBlockDownloadButton,
  escapeCsvCell,
  escapeTsvCell,
  tableToCsv,
  tableToTsv,
  tableToMarkdown,
  inlineToPlainText,
  getCodeSnippetFilename,
  getExtensionForLanguage,
  resolveControlsConfig,
  resolveCodeControls,
  resolveTableControls,
  resolveMermaidControls,
  DEFAULT_CONTROLS_LABELS,
} from "./components";
