import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { StreamingMarkdown, type NodePresentations, type NodeViewProps, type StreamingMarkdownHandle } from "@stream-mdx/react";
import { defineContentComponent, type ContentComponentHostProps, type ContentComponentProps } from "../src/components/content-components";
import { installTrustedNativeTestDom, waitFor, workerFactory } from "./trusted-native-fixture";

async function restrictedComponentUsesItsPresentationWrapper(): Promise<void> {
  type CalloutProps = { readonly title: string };
  const Callout: React.FC<CalloutProps & ContentComponentHostProps> = ({ title, children }) => (
    <aside data-callout-title={title}>{children}</aside>
  );
  const contentComponents = {
    Callout: defineContentComponent<CalloutProps>({
      component: Callout,
      validateProps: (props): props is ContentComponentProps & CalloutProps => typeof props.title === "string",
    }),
  };
  const components = {
    "component:Callout": {
      wrapper: ({ children }: NodeViewProps) => <section data-component-presentation>{children}</section>,
    },
  } satisfies NodePresentations;
  const restore = installTrustedNativeTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const handle = React.createRef<StreamingMarkdownHandle>();

  try {
    await act(async () => {
      root.render(
        <StreamingMarkdown
          ref={handle}
          worker={() => workerFactory()}
          features={{ html: false, mdx: true, tables: false, math: false }}
          contentComponents={contentComponents}
          components={components}
          caret={false}
        />,
      );
    });
    await waitFor(() => handle.current?.getState().workerReady === true, "restricted component worker ready");
    await act(async () => {
      handle.current?.append('<Callout title="Prepared">Prepared child</Callout>');
      await handle.current?.finalize();
    });
    await waitFor(() => container.querySelector("section[data-component-presentation]"), "restricted component presentation");

    const presentation = container.querySelector("section[data-component-presentation]");
    assert.equal(presentation?.firstElementChild?.tagName, "ASIDE");
    assert.equal(presentation?.querySelector("aside")?.getAttribute("data-callout-title"), "Prepared");
    assert.equal(presentation?.textContent, "Prepared child");
  } finally {
    await act(async () => root.unmount());
    restore();
  }
}

await restrictedComponentUsesItsPresentationWrapper();
