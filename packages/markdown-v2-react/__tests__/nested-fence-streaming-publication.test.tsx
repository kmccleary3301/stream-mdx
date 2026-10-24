import assert from "node:assert/strict";
import { STREAM_MDX_SCHEMA_VERSION, type WorkerIn, type WorkerOut } from "@stream-mdx/core";
import { MarkdownEngine } from "@stream-mdx/worker/engine";
import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { normalizeHtmlSemantics } from "../../../tests/conformance/normalizer.mts";
import { ComponentRegistry } from "../src/components";
import { MarkdownBlocksRenderer } from "../src/renderer/blocks-renderer";
import { createRendererStore, type RendererStore } from "../src/renderer/store";

const SOURCE = "- ```\n  code\n  ```\n\n  | a |\n  | - |\n  | b |\n";
const INIT_CONFIG = {
  schemaVersion: STREAM_MDX_SCHEMA_VERSION,
  docPlugins: { html: true, tables: true, footnotes: true, math: true, callouts: true, mdx: false },
  mdx: { compileMode: "server" as const },
  prewarmLangs: [],
};

interface Session {
  engine: MarkdownEngine;
  messages: WorkerOut[];
  store: RendererStore;
}

async function send(session: Session, message: WorkerIn): Promise<WorkerOut[]> {
  await session.engine.handle(message);
  const messages = session.messages.splice(0);
  for (const output of messages) {
    if (output.type === "ERROR") throw new Error(`${output.phase}: ${output.error.message}`);
    if (output.type === "INITIALIZED") session.store.resetSnapshot(output.snapshot);
    else if (output.type === "PATCH") session.store.applyPatches(output.patches);
  }
  return messages;
}

async function startSession(session: Session): Promise<void> {
  const messages = await send(session, { type: "INIT", initialContent: "", ...INIT_CONFIG });
  assert.ok(messages.some((message) => message.type === "INITIALIZED"), "worker must publish its initialized snapshot");
}

function renderStore(store: RendererStore): string {
  return normalizeHtmlSemantics(renderToStaticMarkup(
    React.createElement(MarkdownBlocksRenderer, {
      blocks: [],
      store,
      componentRegistry: new ComponentRegistry(),
    }),
  ));
}

async function coldRender(cold: Session, prefix: string): Promise<string> {
  cold.store = createRendererStore();
  await startSession(cold);
  await send(cold, { type: "APPEND", text: prefix });
  return renderStore(cold.store);
}

async function runNestedFenceStreamingPublicationRegression(): Promise<void> {
  const dom = new JSDOM("");
  const globalsBefore = ["window", "document", "DOMParser", "Node", "Element", "HTMLElement"]
    .map((name) => ({ name, descriptor: Object.getOwnPropertyDescriptor(globalThis, name) }));
  const originalError = console.error;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    DOMParser: dom.window.DOMParser,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
  });
  console.error = (...args: unknown[]) => {
    const message = String(args[0] ?? "");
    if (message.includes("useLayoutEffect does nothing on the server")) return;
    originalError(...args);
  };

  const createSession = (): Session => {
    const messages: WorkerOut[] = [];
    return {
      engine: new MarkdownEngine({ post: (message) => messages.push(message) }),
      messages,
      store: createRendererStore(),
    };
  };
  try {
    for (const chunkSize of [1, 2, 3, 5, 6, 9]) {
      const stream = createSession();
      const cold = createSession();
      try {
        await startSession(stream);
        for (let offset = 0; offset < SOURCE.length; offset += chunkSize) {
          const frontier = Math.min(offset + chunkSize, SOURCE.length);
          await send(stream, { type: "APPEND", text: SOURCE.slice(offset, frontier) });


          assert.equal(
            renderStore(stream.store),
            await coldRender(cold, SOURCE.slice(0, frontier)),
            `published HTML must match a cold render at size=${chunkSize} frontier ${frontier}`,
          );
        }
      } finally {
        stream.engine.dispose();
        cold.engine.dispose();
      }
    }
  } finally {
    console.error = originalError;
    for (const { name, descriptor } of globalsBefore) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
}

await runNestedFenceStreamingPublicationRegression();
console.log("nested fence streaming publication test passed");
