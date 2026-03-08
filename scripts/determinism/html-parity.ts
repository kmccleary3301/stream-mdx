#!/usr/bin/env tsx

import assert from "node:assert";
import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { firstDiffIndex, diffContext } from "../regression/utils";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const FIXTURES: Array<{
  name: string;
  text: string;
  expect: { headingId: string; table?: boolean; code?: boolean };
}> = [
  {
    name: "tables+code",
    text: [
      "# HTML Parity Fixture",
      "",
      "A paragraph with `inline code` and a [link](https://example.com).",
      "",
      "## Table",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "## Code",
      "",
      "```ts",
      "export const x = 1;",
      "```",
      "",
    ].join("\n"),
    expect: { headingId: "html-parity-fixture", table: true, code: true },
  },
  {
    name: "lists+blockquote",
    text: [
      "# Parity Fixture Two",
      "",
      "## Lists",
      "",
      "- Item 1",
      "  - Nested 1",
      "- Item 2",
      "",
      "> Blockquote with **bold** and `code`.",
      "",
      "## Inline HTML",
      "",
      "<span>hello</span>",
      "",
    ].join("\n"),
    expect: { headingId: "parity-fixture-two", table: false, code: false },
  },
];

async function ensureDistBuilds(): Promise<{
  worker: typeof import("../../packages/markdown-v2-worker/dist/node/index.mjs");
  react: typeof import("../../packages/markdown-v2-react/dist/index.mjs");
  reactServer: typeof import("../../packages/markdown-v2-react/dist/server.mjs");
}> {
  const workerDist = path.join(ROOT, "packages", "markdown-v2-worker", "dist", "node", "index.mjs");
  const reactDist = path.join(ROOT, "packages", "markdown-v2-react", "dist", "index.mjs");
  const reactServerDist = path.join(ROOT, "packages", "markdown-v2-react", "dist", "server.mjs");

  const needsWorkerBuild = await fs
    .access(workerDist)
    .then(() => false)
    .catch(() => true);
  const needsReactBuild = await fs
    .access(reactDist)
    .then(() => false)
    .catch(() => true);
  const needsReactServerBuild = await fs
    .access(reactServerDist)
    .then(() => false)
    .catch(() => true);

  if (needsWorkerBuild) execSync("npm -w @stream-mdx/worker run build", { cwd: ROOT, stdio: "inherit" });
  if (needsReactBuild || needsReactServerBuild) execSync("npm -w @stream-mdx/react run build", { cwd: ROOT, stdio: "inherit" });

  const worker = (await import(`${pathToFileURL(workerDist).href}?v=${Date.now()}`)) as typeof import("../../packages/markdown-v2-worker/dist/node/index.mjs");
  const react = (await import(`${pathToFileURL(reactDist).href}?v=${Date.now()}`)) as typeof import("../../packages/markdown-v2-react/dist/index.mjs");
  const reactServer = (await import(`${pathToFileURL(reactServerDist).href}?v=${Date.now()}`)) as typeof import("../../packages/markdown-v2-react/dist/server.mjs");
  return { worker, react, reactServer };
}

function canonicalize(html: string): string {
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  const root = dom.window.document.getElementById("root");
  if (!root) return "";

  for (const el of Array.from(root.querySelectorAll("*"))) {
    // Remove transient React attrs if they appear (they shouldn't for these render paths).
    el.removeAttribute("data-reactroot");
    el.removeAttribute("data-reactid");
  }
  return root.innerHTML;
}

async function main(): Promise<void> {
  const { worker, react, reactServer } = await ensureDistBuilds();
  const { compileMarkdownSnapshot } = worker;
  const { MarkdownBlocksRenderer: ClientMarkdownBlocksRenderer, ComponentRegistry: ClientRegistry } = react;
  const { MarkdownBlocksRenderer: ServerMarkdownBlocksRenderer, ComponentRegistry: ServerRegistry } = reactServer;

  const consoleErrors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
    originalConsoleError(...args);
  };

  try {
    for (const fixture of FIXTURES) {
      // Ensure "server render" runs in a truly server-like environment even though this
      // script uses JSDOM for hydration. Otherwise `typeof window !== "undefined"` can
      // leak across fixtures and accidentally activate client-only paths.
      for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "DOMParser"] as const) {
        // biome-ignore lint/suspicious/noExplicitAny: intentional global cleanup
        delete (globalThis as any)[key];
      }

      const compiled = await compileMarkdownSnapshot({
        text: fixture.text,
        init: {
          docPlugins: { tables: true, html: true, mdx: false, math: false, footnotes: false, callouts: false },
          mdx: { compileMode: "server" },
        },
      });

      // Render server markup.
      const serverRegistry = new ServerRegistry();
      const serverMarkup = renderToStaticMarkup(
        React.createElement(ServerMarkdownBlocksRenderer, {
          blocks: compiled.blocks,
          componentRegistry: serverRegistry,
          className: "markdown-v2-output",
        }),
      );

      const dom = new JSDOM(`<div id="app">${serverMarkup}</div>`, { url: "http://localhost/" });
      const app = dom.window.document.getElementById("app");
      assert.ok(app, "expected jsdom app container");

      // Hydrate using the client renderer on top of server markup.
      Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
      Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
      Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
      Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
      Object.defineProperty(globalThis, "Node", { value: dom.window.Node, configurable: true });
      Object.defineProperty(globalThis, "DOMParser", { value: dom.window.DOMParser, configurable: true });

      const clientRegistry = new ClientRegistry();
      hydrateRoot(
        app,
        React.createElement(ClientMarkdownBlocksRenderer, {
          blocks: compiled.blocks,
          componentRegistry: clientRegistry,
          className: "markdown-v2-output",
        }),
      );

      // Give React a tick to run hydration work.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      if (consoleErrors.some((line) => line.toLowerCase().includes("hydration"))) {
        throw new Error(`[html-parity] hydration warnings detected:\n${consoleErrors.join("\n")}`);
      }

      const canonServer = canonicalize(serverMarkup);
      const canonHydrated = canonicalize(app.innerHTML);

      // Sanity checks that the content exists and is meaningful.
      assert.ok(canonServer.includes(`id="${fixture.expect.headingId}"`), `${fixture.name}: server: expected heading id`);
      assert.ok(canonHydrated.includes(`id="${fixture.expect.headingId}"`), `${fixture.name}: hydrated: expected heading id`);
      if (fixture.expect.table) {
        assert.ok(canonServer.includes("<table"), `${fixture.name}: server: expected table markup`);
        assert.ok(canonHydrated.includes("<table"), `${fixture.name}: hydrated: expected table markup`);
      }
      if (fixture.expect.code) {
        assert.ok(canonServer.includes("<pre"), `${fixture.name}: server: expected code markup`);
        assert.ok(canonHydrated.includes("<pre"), `${fixture.name}: hydrated: expected code markup`);
      }

      if (canonServer !== canonHydrated) {
        const index = firstDiffIndex(canonServer, canonHydrated);
        throw new Error(
          [
            `[html-parity] mismatch (server vs hydrated client) fixture=${fixture.name}`,
            `first diff index: ${index}`,
            `server context:   ${diffContext(canonServer, index)}`,
            `hydrated context: ${diffContext(canonHydrated, index)}`,
          ].join("\n"),
        );
      }

      process.stdout.write(`[html-parity] OK fixture=${fixture.name}\n`);
    }
  } finally {
    console.error = originalConsoleError;
  }
}

main().catch((error) => {
  console.error("[html-parity] failed", error);
  process.exit(1);
});
