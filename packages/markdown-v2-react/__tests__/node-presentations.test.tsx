import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { StreamingMarkdown, type NodePresentations } from "@stream-mdx/react";
import { mergeNodePresentationProps, resolveNodePresentation, validateNodePresentations } from "../src/renderer/node-presentations";

const Chrome: React.FC<{ children?: React.ReactNode }> = ({ children }) => <section data-chrome>{children}</section>;

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
console.log("Unified node presentation registry checks passed");
