import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { STREAM_MDX_SCHEMA_VERSION, type WorkerOut } from "@stream-mdx/core";
import { compileMarkdownSnapshotDirect } from "@stream-mdx/worker/direct";
import { createWorkerThread } from "@stream-mdx/worker/node";
import { ComponentRegistry, MarkdownBlocksRenderer, createRendererStore } from "@stream-mdx/react/server";
import type { RendererStore } from "@stream-mdx/react/server";

import { normalizeHtmlSemantics } from "../../../tests/conformance/normalizer.mts";

const hostedBundle = new URL("../../markdown-v2-worker/dist/hosted/markdown-worker.js", import.meta.url);
if (!existsSync(hostedBundle)) {
  execSync("npm run build:hosted", {
    cwd: fileURLToPath(new URL("../../markdown-v2-worker", import.meta.url)),
    stdio: "inherit",
  });
}

type CommonMarkExample = { number: number; markdown: string; html: string };
const examples = JSON.parse(
  await fs.readFile(new URL("../../../tests/conformance/fixtures/commonmark-spec-0.31.2.json", import.meta.url), "utf8"),
) as CommonMarkExample[];
const assigned = [57, 128];
const init = {
  schemaVersion: STREAM_MDX_SCHEMA_VERSION,
  docPlugins: { html: true, tables: true, footnotes: true, math: true, callouts: true, mdx: false },
  mdx: { compileMode: "server" as const },
  prewarmLangs: [],
};

function render(blocks: Parameters<typeof MarkdownBlocksRenderer>[0]["blocks"], store?: RendererStore): string {
  return normalizeHtmlSemantics(
    renderToStaticMarkup(
      React.createElement(MarkdownBlocksRenderer, {
        blocks,
        store,
        componentRegistry: new ComponentRegistry(),
      }),
    ),
  );
}

async function renderStreamed(markdown: string): Promise<string> {
  const worker = createWorkerThread();
  const store = createRendererStore();
  try {
    await new Promise<void>((resolve, reject) => {
      worker.on("message", (message: WorkerOut) => {
        if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
        else if (message.type === "PATCH") store.applyPatches(message.patches);
        else if (message.type === "FINALIZED") resolve();
        else if (message.type === "ERROR") reject(new Error(message.error.message));
      });
      worker.on("error", reject);
      worker.postMessage({ type: "INIT", initialContent: "", ...init });
      for (let i = 0; i < markdown.length; i += 7) {
        worker.postMessage({ type: "APPEND", text: markdown.slice(i, i + 7) });
      }
      worker.postMessage({ type: "FINALIZE" });
    });
    return render([], store);
  } finally {
    await worker.terminate();
  }
}


const failures: string[] = [];
for (const number of assigned) {
  const example = examples.find((candidate) => candidate.number === number)!;
  const markdown = example.markdown.replace(/→/g, "\t");
  const expected = normalizeHtmlSemantics(example.html.replace(/→/g, "\t"));
  const compiled = await compileMarkdownSnapshotDirect({ text: markdown, init });
  const cold = render(compiled.blocks);
  const streamed = await renderStreamed(markdown);

  if (cold !== expected) failures.push(`cm_${number} cold React output\nexpected: ${expected}\nactual: ${cold}`);
  if (streamed !== expected) failures.push(`cm_${number} streamed React output\nexpected: ${expected}\nactual: ${streamed}`);
}

assert.deepEqual(failures, [], failures.join("\n"));
