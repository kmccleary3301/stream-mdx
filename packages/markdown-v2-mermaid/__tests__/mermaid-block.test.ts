import assert from "node:assert";
import { JSDOM } from "jsdom";
import React from "react";
import { createMermaidBlock } from "../src";
import type {
  MermaidErrorComponentProps,
  MermaidModule,
} from "../src";

const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  pretendToBeVisual: true,
});
const { window } = dom;
const originalDomGlobals: Record<string, PropertyDescriptor | undefined> = {};
const domGlobalValues = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
};
for (const [name, value] of Object.entries(domGlobalValues)) {
  originalDomGlobals[name] = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

// ReactDOM must initialize only after Node's navigator and the isolated DOM globals exist.
const { createRoot } = await import("react-dom/client");

async function waitFor(condition: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition in test");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function setupDom() {
  const root = window.document.createElement("div");
  root.id = "root";
  window.document.body.replaceChildren(root);
  return window;
}

async function drainEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// Provider work is held and released by tests, so its resolver functions must be retained.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function restoreDomGlobals(): void {
  for (const name of Object.keys(domGlobalValues)) {
    const descriptor = originalDomGlobals[name];
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  }
}

function diagramSvg(nodeLabel: string): string {
  return `<svg role="img"><text>${nodeLabel}</text></svg>`;
}

async function testCodeAndDiagramNavigation() {
  const window = await setupDom();
  const NavigationBlock = createMermaidBlock({
    mermaid: {
      render: async () => ({ svg: diagramSvg("Destination B") }),
    },
    debounceMs: 0,
  });
  const container = window.document.getElementById("root");
  assert.ok(container, "root element required");
  const root = createRoot(container);

  root.render(
    React.createElement(NavigationBlock, {
      code: "graph TD; A-->B;",
      renderCode: React.createElement("pre", { id: "code-view" }, "Code fallback"),
      language: "mermaid",
    }),
  );
  await waitFor(
    () =>
      container.querySelector(".stream-mdx-mermaid-diagram svg text")?.textContent ===
      "Destination B",
  );
  assert.ok(container.querySelector(".stream-mdx-mermaid-toolbar"));

  const codeButton = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Code",
  );
  assert.ok(codeButton, "Code view control must be available");
  codeButton.click();
  await waitFor(() => Boolean(container.querySelector("#code-view")));
  assert.ok(container.querySelector("#code-view"), "Code view must render after navigation");

  const diagramButton = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Diagram",
  );
  assert.ok(diagramButton, "Diagram view control must be available");
  diagramButton.click();
  await waitFor(
    () =>
      container.querySelector(".stream-mdx-mermaid-diagram svg text")?.textContent ===
      "Destination B",
  );
  root.unmount();
}

async function testCustomErrorComponentAndRetry() {
  const window = await setupDom();
  let shouldFail = true;
  const mockMermaid: MermaidModule = {
    render: async () => {
      if (shouldFail) throw new Error("Invalid diagram syntax.");
      return { svg: diagramSvg("Recovered destination") };
    },
  };
  const CustomError: React.FC<MermaidErrorComponentProps> = ({ error, retry }) =>
    React.createElement(
      "div",
      null,
      React.createElement("div", { role: "alert" }, error),
      React.createElement("button", { type: "button", onClick: retry }, "Try Again"),
    );
  const CustomBlock = createMermaidBlock({
    mermaid: mockMermaid,
    errorComponent: CustomError,
    debounceMs: 0,
  });
  const container = window.document.getElementById("root");
  assert.ok(container, "root element required");
  const root = createRoot(container);

  root.render(
    React.createElement(CustomBlock, {
      code: "graph TD; Broken-->???",
      renderCode: React.createElement("pre", null, "Code fallback"),
      language: "mermaid",
    }),
  );
  await waitFor(() => Boolean(container.querySelector('[role="alert"]')));

  shouldFail = false;
  const retryButton = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Try Again",
  );
  assert.ok(retryButton, "error view must expose its retry control");
  retryButton.click();
  await waitFor(
    () =>
      container.querySelector(".stream-mdx-mermaid-diagram svg text")?.textContent ===
      "Recovered destination",
  );
  assert.strictEqual(container.querySelector('[role="alert"]'), null);
  root.unmount();
}


async function testDetachedQueuedDemandSkipsProviderWork() {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "root element required");
  const busyResult = deferred<{ svg: string }>();
  let busyRenderStarted = false;
  const BusyBlock = createMermaidBlock({
    mermaid: {
      render: async () => {
        busyRenderStarted = true;
        return busyResult.promise;
      },
    },
    debounceMs: 0,
  });
  const detachedEffects: string[] = [];
  const DetachedBlock = createMermaidBlock({
    mermaid: {
      initialize: () => detachedEffects.push("initialize"),
      render: async () => {
        detachedEffects.push("render");
        return { svg: diagramSvg("Detached destination") };
      },
    },
    debounceMs: 0,
  });
  const root = createRoot(container);
  const busyView = React.createElement(BusyBlock, {
    key: "busy",
    blockId: "busy-owner",
    code: "graph TD; Busy-->Destination;",
    renderCode: React.createElement("pre", null, "busy source"),
    language: "mermaid",
  });

  root.render(React.createElement("div", null, [busyView]));
  await waitFor(() => busyRenderStarted);

  const detachedView = React.createElement(DetachedBlock, {
    key: "detached",
    blockId: "detached-owner",
    code: "graph TD; Detached-->Destination;",
    renderCode: React.createElement("pre", null, "detached source"),
    language: "mermaid",
  });
  root.render(React.createElement("div", null, [busyView, detachedView]));
  await waitFor(() => container.querySelectorAll(".stream-mdx-mermaid-block").length === 2);
  await drainEventLoop();

  root.render(React.createElement("div", null, [busyView]));
  await waitFor(() => container.querySelectorAll(".stream-mdx-mermaid-block").length === 1);
  busyResult.resolve({ svg: diagramSvg("Busy destination") });
  await waitFor(
    () =>
      container.querySelector(".stream-mdx-mermaid-diagram svg text")?.textContent ===
      "Busy destination",
  );
  await drainEventLoop();

  assert.deepStrictEqual(detachedEffects, [], "detached queued demand must not initialize or render");
  assert.strictEqual(
    container.querySelector(".stream-mdx-mermaid-diagram svg text")?.textContent,
    "Busy destination",
    "the mounted diagram must retain its rendered meaning",
  );
  root.unmount();
}

async function testDetachmentDuringModuleLoadSkipsProviderWork() {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "root element required");
  const loadedModule = deferred<MermaidModule>();
  const providerEffects: string[] = [];
  let loaderStarted = false;
  const Block = createMermaidBlock({
    mermaid: () => {
      loaderStarted = true;
      return loadedModule.promise;
    },
    debounceMs: 0,
  });
  const root = createRoot(container);

  root.render(
    React.createElement(Block, {
      code: "graph TD; Pending-->Module;",
      renderCode: React.createElement("pre", null, "pending source"),
      language: "mermaid",
    }),
  );
  await waitFor(() => loaderStarted);
  root.unmount();

  loadedModule.resolve({
    initialize: () => providerEffects.push("initialize"),
    render: async () => {
      providerEffects.push("render");
      return { svg: diagramSvg("Detached destination") };
    },
  });
  await drainEventLoop();

  assert.deepStrictEqual(
    providerEffects,
    [],
    "a detached lease must not initialize or render after its loader resolves",
  );
}

async function testOwnerReplacementPublishesOnlyCurrentRender() {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "root element required");
  const obsoleteResult = deferred<{ svg: string }>();
  const currentResult = deferred<{ svg: string }>();
  let renderCalls = 0;
  let currentRenderStarted = false;
  const Block = createMermaidBlock({
    mermaid: {
      render: async () => {
        renderCalls += 1;
        if (renderCalls === 1) return obsoleteResult.promise;
        currentRenderStarted = true;
        return currentResult.promise;
      },
    },
    debounceMs: 0,
  });
  const root = createRoot(container);
  const source = "graph TD; Source-->Destination;";

  root.render(
    React.createElement(Block, {
      blockId: "previous-owner",
      code: source,
      renderCode: React.createElement("pre", null, "source"),
      language: "mermaid",
    }),
  );
  await waitFor(() => renderCalls === 1);
  root.render(
    React.createElement(Block, {
      blockId: "current-owner",
      code: source,
      renderCode: React.createElement("pre", null, "source"),
      language: "mermaid",
    }),
  );
  await drainEventLoop();

  obsoleteResult.resolve({ svg: diagramSvg("Obsolete destination") });
  await waitFor(() => currentRenderStarted);
  assert.strictEqual(
    container.querySelector(".stream-mdx-mermaid-diagram svg"),
    null,
    "the obsolete owner must not publish while the current render is pending",
  );

  currentResult.resolve({ svg: diagramSvg("Current destination") });
  await waitFor(
    () =>
      container.querySelector(".stream-mdx-mermaid-diagram svg text")?.textContent ===
      "Current destination",
  );
  assert.strictEqual(
    container.querySelector(".stream-mdx-mermaid-stale"),
    null,
    "a replaced owner must not retain an artifact from the prior owner",
  );
  root.unmount();
}

async function testObsoleteFailureCannotReplaceCurrentDiagnostic() {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "root element required");
  const obsoleteResult = deferred<{ svg: string }>();
  let renderCalls = 0;
  const ErrorView: React.FC<MermaidErrorComponentProps> = ({ error }) =>
    React.createElement("div", { role: "alert" }, error);
  const Block = createMermaidBlock({
    mermaid: {
      render: async () => {
        renderCalls += 1;
        if (renderCalls === 1) return obsoleteResult.promise;
        throw new Error("The active diagram failed to render.");
      },
    },
    errorComponent: ErrorView,
    debounceMs: 0,
  });
  const root = createRoot(container);
  const source = "graph TD; Source-->Destination;";

  root.render(
    React.createElement(Block, {
      blockId: "previous-owner",
      code: source,
      renderCode: React.createElement("pre", null, "source"),
      language: "mermaid",
    }),
  );
  await waitFor(() => renderCalls === 1);
  const observedDiagnostics = new Set<string>();
  const observer = new window.MutationObserver(() => {
    const diagnostic = container.querySelector('[role="alert"]')?.textContent;
    if (diagnostic) observedDiagnostics.add(diagnostic);
  });
  observer.observe(container, { childList: true, characterData: true, subtree: true });

  root.render(
    React.createElement(Block, {
      blockId: "current-owner",
      code: source,
      renderCode: React.createElement("pre", null, "source"),
      language: "mermaid",
    }),
  );
  await drainEventLoop();
  obsoleteResult.reject(new Error("A retired diagram failed."));
  await waitFor(
    () =>
      container.querySelector('[role="alert"]')?.textContent ===
      "The active diagram failed to render.",
  );
  await drainEventLoop();
  observer.disconnect();

  assert.deepStrictEqual(
    [...observedDiagnostics],
    ["The active diagram failed to render."],
    "only the current owner's diagnostic may reach the rendered error boundary",
  );
  root.unmount();
}

async function testBindingDisposersPreserveOtherMountedDiagrams() {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "root element required");
  const navigation = window.document.createElement("nav");
  window.document.body.append(navigation);
  const sourceByNodeLabel: Record<string, string> = {
    "graph TD; A-->B;": "Destination B",
    "graph TD; A-->C;": "Destination C",
    "graph TD; D-->E;": "Destination E",
  };
  const Block = createMermaidBlock({
    mermaid: {
      render: async (_id, code) => {
        const nodeLabel = sourceByNodeLabel[code];
        if (!nodeLabel) throw new Error("Unexpected test diagram");
        return {
          svg: diagramSvg(nodeLabel),
          bindFunctions: (element) => {
            const boundNode = element.querySelector("text")?.textContent ?? "";
            const navigate = () => {
              const item = window.document.createElement("span");
              item.textContent = boundNode;
              navigation.append(item);
            };
            window.addEventListener("mermaid-provider-navigation", navigate);
            return () => window.removeEventListener("mermaid-provider-navigation", navigate);
          },
        };
      },
    },
    debounceMs: 0,
  });
  const root = createRoot(container);
  const elementFor = (key: string, code: string) =>
    React.createElement(Block, {
      key,
      blockId: key,
      code,
      renderCode: React.createElement("pre", null, "diagram source"),
      language: "mermaid",
    });
  const navigationAfterEvent = () => {
    navigation.replaceChildren();
    window.dispatchEvent(new window.Event("mermaid-provider-navigation"));
    return Array.from(navigation.querySelectorAll("span"), (item) => item.textContent ?? "");
  };
  const navigationMatches = (expected: string[]) => {
    const actual = navigationAfterEvent().sort();
    return actual.length === expected.length && actual.every((label, index) => label === expected[index]);
  };


  root.render(
    React.createElement("div", null, [
      elementFor("first-owner", "graph TD; A-->B;"),
      elementFor("second-owner", "graph TD; D-->E;"),
    ]),
  );
  await waitFor(() => navigationMatches(["Destination B", "Destination E"]));
  const initialMeaning = Array.from(
    container.querySelectorAll(".stream-mdx-mermaid-diagram svg text"),
    (node) => node.textContent ?? "",
  ).sort();
  assert.deepStrictEqual(initialMeaning, ["Destination B", "Destination E"]);
  assert.deepStrictEqual(
    navigationAfterEvent().sort(),
    ["Destination B", "Destination E"],
    "both mounted providers must retain their host navigation effect",
  );

  root.render(
    React.createElement("div", null, [
      elementFor("first-owner", "graph TD; A-->C;"),
      elementFor("second-owner", "graph TD; D-->E;"),
    ]),
  );
  await waitFor(() =>
    Array.from(
      container.querySelectorAll(".stream-mdx-mermaid-diagram svg text"),
      (node) => node.textContent,
    ).includes("Destination C"),
  );
  await waitFor(() => navigationMatches(["Destination C", "Destination E"]));
  const replacedMeaning = Array.from(
    container.querySelectorAll(".stream-mdx-mermaid-diagram svg text"),
    (node) => node.textContent ?? "",
  ).sort();
  assert.deepStrictEqual(replacedMeaning, ["Destination C", "Destination E"]);
  assert.deepStrictEqual(
    navigationAfterEvent().sort(),
    ["Destination C", "Destination E"],
    "replacement must dispose the old provider effect without disturbing the other diagram",
  );

  root.render(React.createElement("div", null, [elementFor("second-owner", "graph TD; D-->E;")]));
  await waitFor(() => container.querySelectorAll(".stream-mdx-mermaid-block").length === 1);
  await waitFor(() => navigationMatches(["Destination E"]));
  assert.deepStrictEqual(
    Array.from(
      container.querySelectorAll(".stream-mdx-mermaid-diagram svg text"),
      (node) => node.textContent ?? "",
    ),
    ["Destination E"],
    "the remaining mounted diagram must keep its current meaning",
  );
  assert.deepStrictEqual(
    navigationAfterEvent(),
    ["Destination E"],
    "unmount must dispose only the removed provider effect",
  );
  root.unmount();
}

async function main() {
  await testCodeAndDiagramNavigation();
  console.log("Code and Diagram navigation passed");

  await testCustomErrorComponentAndRetry();
  console.log("Error and retry transitions passed");

  await testDetachedQueuedDemandSkipsProviderWork();
  console.log("Detached queued demand skipped provider work");

  await testDetachmentDuringModuleLoadSkipsProviderWork();
  console.log("Detachment during module load skipped provider work");

  await testOwnerReplacementPublishesOnlyCurrentRender();
  console.log("Owner replacement published only current render");

  await testObsoleteFailureCannotReplaceCurrentDiagnostic();
  console.log("Obsolete failure did not replace current diagnostic");

  await testBindingDisposersPreserveOtherMountedDiagrams();
  console.log("Binding disposers preserved independent mounted diagrams");
}

try {
  await main();
} finally {
  dom.window.close();
  restoreDomGlobals();
}
