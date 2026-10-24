import type { RestrictedComponentDescriptor, SyntaxExtensionDescriptor } from "@stream-mdx/core";
import React from "react";
import {
  ComponentRegistry,
  defineContentComponent,
  type ContentComponentHostProps,
  type ContentComponentProps,
} from "@stream-mdx/react";

interface DemoNoteProps {
  readonly title: string;
}

function DemoNote({
  title,
  children,
  "data-component-status": status,
  "data-diagnostic": diagnostic,
}: DemoNoteProps & ContentComponentHostProps): React.ReactElement {
  return (
    <aside
      data-syntax-container="note"
      data-note-title={title}
      data-component-status={status}
      data-diagnostic={diagnostic}
    >
      <strong>{title}</strong>
      {children}
    </aside>
  );
}

export const STREAMING_SYNTAX_DEMO = {
  contractVersion: 1,
  inline: [
    {
      name: "highlight",
      trigger: "==",
      pattern: { source: "==([^=\\n]+)==" },
      attrs: { text: 1 },
      anticipation: { open: "==", close: "==" },
    },
  ],
  containers: [{ name: "note", component: "DemoNote" }],
} satisfies SyntaxExtensionDescriptor;

export const STREAMING_SYNTAX_DEMO_MARKDOWN = [
  "Streaming ==highlight== works.",
  "",
  ':::note {"title":"Demo note"}',
  "Notes use **native markdown**.",
  ":::",
  "",
  "Done.",
].join("\n");

export const STREAMING_SYNTAX_DEMO_CONTENT_COMPONENTS = {
  DemoNote: defineContentComponent<DemoNoteProps>({
    component: DemoNote,
    validateProps: (props: ContentComponentProps): props is ContentComponentProps & DemoNoteProps =>
      typeof props.title === "string",
    renderWhen: "open",
  }),
};

export const STREAMING_SYNTAX_DEMO_WORKER_COMPONENTS = Object.entries(STREAMING_SYNTAX_DEMO_CONTENT_COMPONENTS).map(
  ([name, registration]) => ({ name, renderWhen: registration.renderWhen }),
) satisfies RestrictedComponentDescriptor[];

export const STREAMING_SYNTAX_DEMO_INLINE_COMPONENTS = {
  highlight: ({ text }: { readonly text?: string }) => <mark data-syntax-highlight="true">{text}</mark>,
};

export function createStreamingSyntaxDemoRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  registry.setInlineComponents(STREAMING_SYNTAX_DEMO_INLINE_COMPONENTS);
  registry.setContentComponents(STREAMING_SYNTAX_DEMO_CONTENT_COMPONENTS);
  return registry;
}
