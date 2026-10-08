import React from "react";
import { MarkdownBlocksRenderer as BaseMarkdownBlocksRenderer, type MarkdownBlocksRendererProps } from "./renderer/blocks-renderer";

export const MarkdownBlocksRenderer: React.FC<MarkdownBlocksRendererProps> = (props) => {
  if (props.componentRegistry) {
    props.componentRegistry.setAnimated(false);
  }
  return React.createElement(BaseMarkdownBlocksRenderer, {
    ...props,
    animated: false,
  });
};
export type { MarkdownBlocksRendererProps };
export { ComponentRegistry } from "./components";
export { createRendererStore } from "./renderer/store";
export { defaultUrlTransform } from "@stream-mdx/core";
export { STREAM_MDX_ANIMATION_CSS, DEFAULT_ANIMATED_OPTIONS } from "./animation";
export type {
  BlockComponents,
  HtmlElements,
  InlineComponents,
  InlineHtmlRenderer,
  InlineHtmlRendererMap,
  RendererConfig,
  TableElements,
  CodeFenceRenderer,
  CodeFenceRendererConfig,
  CodeFenceRendererProps,
  MathRenderer,
  MathRendererProps,
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
