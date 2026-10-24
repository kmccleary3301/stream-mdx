import React from "react";
import { createMermaidBlock } from "@stream-mdx/mermaid";
import type { MermaidModuleLoader } from "@stream-mdx/mermaid";

export const WARM_MARKDOWN = [
  "```mermaid",
  "flowchart TD",
  '  WarmStart["Warm start"] --> WarmEnd["Warm end"]',
  "```",
].join("\n");

export const COOL_MARKDOWN = [
  "```mermaid",
  "flowchart LR",
  '  CoolStart["Cool start"] --> CoolEnd["Cool end"]',
  "```",
].join("\n");

const warmConfig = {
  theme: "base",
  themeVariables: {
    primaryColor: "#fef08a",
    primaryTextColor: "#422006",
    lineColor: "#a16207",
  },
};

const coolConfig = {
  theme: "base",
  themeVariables: {
    primaryColor: "#bfdbfe",
    primaryTextColor: "#172554",
    lineColor: "#1d4ed8",
  },
};

export function createMermaidSmokeRenderers(mermaid?: MermaidModuleLoader) {
  const warm = createMermaidBlock({ config: warmConfig, debounceMs: 0, mermaid });
  const cool = createMermaidBlock({ config: coolConfig, debounceMs: 0, mermaid });
  const renderMermaid = (props: React.ComponentProps<typeof warm>) =>
    React.createElement(props.code.includes("WarmStart") ? warm : cool, props);

  return {
    warm,
    cool,
    codeRenderers: { mermaid: renderMermaid },
  };
}
