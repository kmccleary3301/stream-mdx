import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { StreamingMarkdown, type NodePresentations, type NodeViewProps, type StreamingMarkdownHandle } from "@stream-mdx/react";
import { MarkdownBlocksRenderer as ServerMarkdownBlocksRenderer } from "@stream-mdx/react/server";
import { installTrustedNativeTestDom, waitFor, workerFactory } from "./trusted-native-fixture";
import { mergeNodePresentationProps, resolveNodePresentation, validateNodePresentations } from "../src/renderer/node-presentations";

const Chrome: React.FC<{ children?: React.ReactNode }> = ({ children }) => <section data-chrome>{children}</section>;

async function finalizedHeadingPresentationMatchesServerOutput(): Promise<void> {
  const restore = installTrustedNativeTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const handle = React.createRef<StreamingMarkdownHandle>();
  let presentedActions: NodeViewProps["actions"] | undefined;
  const clipboardWrites: string[] = [];
  const downloads: string[] = [];
  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { clipboardWrites.push(text); } },
  });
  const anchorPrototype = window.HTMLAnchorElement.prototype;
  const originalAnchorClick = anchorPrototype.click;
  anchorPrototype.click = function () { downloads.push(this.download); };
  const components = {
    heading: {
      wrapper: ({ children, metadata, actions }: NodeViewProps) => {
        presentedActions = actions;
        return <section data-heading-presentation data-finalized={metadata.isFinalized}>{children}</section>;
      },
    },
  } satisfies NodePresentations;

  try {
    await act(async () => {
      root.render(
        <StreamingMarkdown
          ref={handle}
          worker={() => workerFactory()}
          contentPolicy="markdown"
          features={{ html: false, mdx: false, tables: false, math: false }}
          caret={false}
          components={components}
        />,
      );
    });
    await waitFor(() => handle.current?.getState().workerReady === true, "worker ready");
    await act(async () => {
      handle.current?.append("## Shared heading");
      await handle.current?.finalize();
    });
    await waitFor(() => container.querySelector("section[data-heading-presentation]"), "finalized heading wrapper");
    const streamingPresentation = container.querySelector("section[data-heading-presentation]");
    assert.ok(presentedActions, "the wrapper receives source-bound presentation actions");
    let copySucceeded = false;
    await act(async () => { copySucceeded = await presentedActions!.copy(); });
    assert.equal(copySucceeded, true);
    assert.deepEqual(clipboardWrites, ["## Shared heading"], "copy reads the exact authored heading source");
    await act(async () => { presentedActions!.download(); });
    assert.deepEqual(downloads, ["heading.txt"], "download uses the presented node's semantic filename");

    const serverMarkup = renderToStaticMarkup(
      <ServerMarkdownBlocksRenderer blocks={handle.current?.getState().blocks ?? []} components={components} />,
    );
    const serverContainer = document.createElement("div");
    serverContainer.innerHTML = serverMarkup;
    const serverPresentation = serverContainer.querySelector("section[data-heading-presentation]");
    assert.strictEqual(streamingPresentation?.outerHTML, serverPresentation?.outerHTML);
    assert.strictEqual(streamingPresentation?.getAttribute("data-finalized"), "true");
  } finally {
    anchorPrototype.click = originalAnchorClick;
    if (previousClipboard) Object.defineProperty(navigator, "clipboard", previousClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
    await act(async () => root.unmount());
    restore();
  }
}

function runNodePresentationsTest(): void {
  const components = {
    paragraph: { wrapper: Chrome, props: { className: "host-paragraph", "data-owner": "host" } },
    "inline:code": { props: { className: "host-inline-code" } },
  } satisfies NodePresentations;

  assert.strictEqual(resolveNodePresentation(components, "paragraph"), components.paragraph);
  assert.equal(resolveNodePresentation(components, "inline:missing"), undefined);
  assert.doesNotThrow(() => validateNodePresentations(components));

  const invalid = {
    paragraph: { wrapper: Chrome, view: Chrome },
  } as unknown as NodePresentations;
  assert.throws(
    () => renderToStaticMarkup(<StreamingMarkdown components={invalid} />),
    /wrapper and view are mutually exclusive/,
  );

  assert.throws(
    () => validateNodePresentations({ "component:bad:name": { props: { className: "x" } } } as NodePresentations),
    /invalid node presentation key/,
  );
  assert.throws(
    () => validateNodePresentations({ paragraph: { props: { children: "replace native children" } } } as unknown as NodePresentations),
    /presentation prop is not allowed/,
  );
  const nativeProps = { className: "native" };
  assert.strictEqual(mergeNodePresentationProps(nativeProps, undefined), nativeProps);
  const merged = mergeNodePresentationProps(
    { className: "native", title: "native title", "aria-label": "native label", style: { color: "red", lineHeight: 1 } },
    { className: "host", title: "host title", "aria-label": "host label", "data-owner": "host", style: { color: "blue" } },
  );
  assert.deepEqual(merged, {
    className: "native host",
    style: { color: "blue", lineHeight: 1 },
    "data-owner": "host",
  });
  assert.throws(
    () => validateNodePresentations({ code: { slots: { controls: <button /> } } } as unknown as NodePresentations),
    /presentation slot is not supported/,
  );
}

runNodePresentationsTest();

await finalizedHeadingPresentationMatchesServerOutput();
console.log("Unified node presentation registry checks passed");
