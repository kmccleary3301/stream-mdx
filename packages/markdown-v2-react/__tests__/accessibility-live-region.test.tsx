import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamingMarkdown } from "../src";

const silentMarkup = renderToStaticMarkup(React.createElement(StreamingMarkdown, { text: "" }));
assert.equal((silentMarkup.match(/role="status"/g) ?? []).length, 0, "streaming is silent by default");
assert.doesNotMatch(silentMarkup, /aria-live=/, "the renderer root does not force a live-region mode");

const coordinatedMarkup = renderToStaticMarkup(
  React.createElement(StreamingMarkdown, { text: "", statusMessage: "Table rendering complete" }),
);
assert.equal((coordinatedMarkup.match(/role="status"/g) ?? []).length, 1, "the host receives one status region");
assert.match(coordinatedMarkup, /role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
assert.match(coordinatedMarkup, />Table rendering complete<\/p>/);

console.log("accessibility live-region policy test passed");
