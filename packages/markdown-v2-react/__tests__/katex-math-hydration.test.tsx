import assert from "node:assert/strict";
import { createRequire } from "node:module";

import React, { act } from "react";
import { renderToString } from "react-dom/server";
import type { Root, hydrateRoot as HydrateRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { KaTeXBlockMath, KaTeXInlineMath, loadKaTeX } from "../src/components/katex-math";

type MathExports = {
  KaTeXInlineMath: typeof KaTeXInlineMath;
  KaTeXBlockMath: typeof KaTeXBlockMath;
  loadKaTeX: typeof loadKaTeX;
};

const requireFromTest = createRequire(import.meta.url);
const serverMath = requireFromTest("../src/components/katex-math.tsx") as MathExports;
const inlineTex = "x^2";
const displayTex = "\\int_0^1 x\\,dx";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });

function mathTree(math: MathExports, inline: string, display: string): React.ReactElement {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(math.KaTeXInlineMath, { tex: inline }),
    React.createElement(math.KaTeXBlockMath, { tex: display }),
  );
}

function findMath(container: ParentNode, tex: string): HTMLElement {
  const node = Array.from(container.querySelectorAll<HTMLElement>("[data-tex]"))
    .find((candidate) => candidate.getAttribute("data-tex") === tex);
  assert.ok(node, `missing rendered math for ${tex}`);
  return node;
}

function assertSourceFallback(container: ParentNode, inline: string, display: string): void {
  const inlineNode = findMath(container, inline);
  const displayNode = findMath(container, display);
  assert.equal(inlineNode.textContent, `$${inline}$`);
  assert.equal(displayNode.textContent, `$$${display}$$`);
  assert.equal(inlineNode.querySelector(".katex"), null, "initial inline math must remain inert");
  assert.equal(displayNode.querySelector(".katex"), null, "initial display math must remain inert");
}

function assertPreparedMath(container: ParentNode, inline: string, display: string): void {
  const inlineNode = findMath(container, inline);
  const displayNode = findMath(container, display);
  const inlineAnnotation = inlineNode.querySelector('annotation[encoding="application/x-tex"]');
  const displayAnnotation = displayNode.querySelector('annotation[encoding="application/x-tex"]');
  assert.ok(inlineNode.querySelector(".katex"), "inline expression should be rendered by KaTeX");
  assert.ok(displayNode.querySelector(".katex"), "display expression should be rendered by KaTeX");
  assert.equal(inlineAnnotation?.textContent, inline);
  assert.equal(displayAnnotation?.textContent, display);
}

async function hydrateMath(
  hydrateRoot: typeof HydrateRoot,
  clientMath: MathExports,
  markup: string,
  inline: string,
  display: string,
): Promise<void> {
  const container = dom.window.document.createElement("div");
  container.innerHTML = markup;
  dom.window.document.body.append(container);
  assertSourceFallback(container, inline, display);

  const recoverableErrors: unknown[] = [];
  let root: Root | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(container, mathTree(clientMath, inline, display), {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
    });
    await act(async () => {
      await clientMath.loadKaTeX();
    });
    assert.deepEqual(recoverableErrors, [], "math hydration must not recover from mismatched markup");
    assertPreparedMath(container, inline, display);
  } finally {
    if (root) await act(async () => root?.unmount());
    container.remove();
  }
}

const coldServerMarkup = renderToString(mathTree(serverMath, inlineTex, displayTex));
const coldServerContainer = dom.window.document.createElement("div");
coldServerContainer.innerHTML = coldServerMarkup;
assertSourceFallback(coldServerContainer, inlineTex, displayTex);

const domGlobals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  DOMParser: dom.window.DOMParser,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const originalDescriptors: Record<keyof typeof domGlobals, PropertyDescriptor | undefined> = {
  window: undefined,
  document: undefined,
  navigator: undefined,
  DOMParser: undefined,
  Node: undefined,
  Element: undefined,
  HTMLElement: undefined,
  MutationObserver: undefined,
  IS_REACT_ACT_ENVIRONMENT: undefined,
};
for (const key of Object.keys(domGlobals) as Array<keyof typeof domGlobals>) {
  originalDescriptors[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: domGlobals[key],
  });
}

try {
  // Install globals before React DOM evaluates; it reads navigator during import.
  // A query URL gives this ESM client a cold instance, separate from CJS SSR and earlier tests.
  const { createRoot, hydrateRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const clientMathUrl = new URL("../src/components/katex-math.tsx", import.meta.url);
  clientMathUrl.searchParams.set("hydration-test", "client");
  const clientMath = (await import(clientMathUrl.href)) as MathExports;

  await hydrateMath(hydrateRoot, clientMath, coldServerMarkup, inlineTex, displayTex);

  await serverMath.loadKaTeX();
  const warmServerMarkup = renderToString(mathTree(serverMath, inlineTex, displayTex));
  await hydrateMath(hydrateRoot, clientMath, warmServerMarkup, inlineTex, displayTex);

  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);
  const nextInlineTex = "z^3";
  const nextDisplayTex = "\\sum_{k=1}^n k";
  try {
    await act(async () => {
      root.render(mathTree(clientMath, inlineTex, displayTex));
    });
    await act(async () => {
      await clientMath.loadKaTeX();
    });
    assertPreparedMath(container, inlineTex, displayTex);

    await act(async () => {
      flushSync(() => root.render(mathTree(clientMath, nextInlineTex, nextDisplayTex)));
      assertSourceFallback(container, nextInlineTex, nextDisplayTex);
    });
    await act(async () => {
      await clientMath.loadKaTeX();
    });
    assertPreparedMath(container, nextInlineTex, nextDisplayTex);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
} finally {
  for (const [key, descriptor] of Object.entries(originalDescriptors)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.window.close();
}

console.log("math hydration and source lifetime test passed");
