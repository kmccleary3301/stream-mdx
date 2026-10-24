const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Keep the worker source in ESM so tsx does not require its ESM-only MDX dependencies.
const engineEntry = process.env.STREAM_MDX_PROPERTY_ENGINE_ENTRY ??
  path.resolve(__dirname, "../../packages/markdown-v2-worker/src/engine/index.ts");
const engineUrl = pathToFileURL(path.resolve(engineEntry)).href;
module.exports = import(engineUrl).then((module) => module.MarkdownEngine);
