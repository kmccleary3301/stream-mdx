import assert from "node:assert";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";
import {
  MermaidBlock,
  __setMermaidModuleForTesting,
  createMermaidBlock,
} from "../src";
import type {
  MermaidErrorComponentProps,
  MermaidModule,
} from "../src";

// Integration test exercises React state transitions and macro-task timeouts.
// waitFor drains event-loop turns via setImmediate rather than fixed wall-clock sleeps.
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
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  (globalThis as unknown as { window: unknown }).window = window;
  (globalThis as unknown as { document: unknown }).document = window.document;
  (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = window.HTMLElement;
  (globalThis as unknown as { Node: unknown }).Node = window.Node;
  (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame =
    window.requestAnimationFrame.bind(window);
  (globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame =
    window.cancelAnimationFrame.bind(window);
  return window;
}

// 1. Default MermaidBlock unchanged
async function testDefaultMermaidBlockUnchanged() {
  const window = await setupDom();
  assert.strictEqual(typeof MermaidBlock, "function", "MermaidBlock should be a React component");
  assert.strictEqual(MermaidBlock.defer, true, "MermaidBlock.defer should be true");

  const initializeCalls: Record<string, unknown>[] = [];
  const mockMermaid: MermaidModule = {
    initialize: (cfg) => {
      initializeCalls.push(cfg);
    },
    render: async (id, code) => ({
      svg: `<svg id="${id}"><text>${code}</text></svg>`,
    }),
  };
  __setMermaidModuleForTesting(mockMermaid);

  const container = window.document.getElementById("root");
  assert.ok(container, "root element required");
  const root = createRoot(container);

  root.render(
    React.createElement(MermaidBlock, {
      code: "graph TD; A-->B;",
      renderCode: React.createElement("pre", { id: "code-view" }, "graph TD; A-->B;"),
      language: "mermaid",
      debounceMs: 0,
    }),
  );

  await waitFor(() => Boolean(container.querySelector(".stream-mdx-mermaid-diagram")));

  // Assert default MermaidBlock rendered toolbar and diagram
  assert.ok(container.querySelector(".stream-mdx-mermaid-toolbar"), "toolbar should render");
  assert.ok(container.querySelector(".stream-mdx-mermaid-diagram"), "diagram container should render");
  assert.ok(container.textContent?.includes("graph TD; A-->B;"), "diagram SVG content should render");

  // Verify initialize config has default strict security level and suppressErrorRendering
  assert.ok(initializeCalls.length > 0, "mermaid.initialize should be called");
  const lastCall = initializeCalls[initializeCalls.length - 1];
  assert.strictEqual(lastCall.securityLevel, "strict", "default securityLevel must be strict");
  assert.strictEqual(lastCall.startOnLoad, false, "startOnLoad must be false");
  assert.strictEqual(lastCall.suppressErrorRendering, true, "suppressErrorRendering must be true");

  // Toggle to Code view
  const buttons = container.querySelectorAll("button");
  const codeBtn = Array.from(buttons).find((b) => b.textContent?.trim() === "Code");
  assert.ok(codeBtn, "Code toggle button must exist");
  codeBtn.click();

  await waitFor(() => Boolean(container.querySelector("#code-view")));
  assert.ok(container.querySelector("#code-view"), "code view must render when toggled");

  // Toggle back to Diagram view
  const diagramBtn = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Diagram",
  );
  assert.ok(diagramBtn, "Diagram toggle button must exist");
  diagramBtn.click();

  await waitFor(() => Boolean(container.querySelector(".stream-mdx-mermaid-diagram")));
  assert.ok(container.querySelector(".stream-mdx-mermaid-diagram"), "diagram view must re-appear");

  root.unmount();

  // Test parse error behavior for default MermaidBlock
  mockMermaid.render = async () => {
    throw new Error("Syntax error in graph");
  };

  const errorRoot = createRoot(container);
  errorRoot.render(
    React.createElement(MermaidBlock, {
      code: "graph TD; syntax_error!!!",
      renderCode: React.createElement("pre", null, "syntax_error"),
      language: "mermaid",
      debounceMs: 0,
    }),
  );

  await waitFor(() => Boolean(container.querySelector(".stream-mdx-mermaid-error")));

  // Default error message div
  const errorDiv = container.querySelector(".stream-mdx-mermaid-error");
  assert.ok(errorDiv, "default MermaidBlock must show default error div on parse error");
  assert.ok(errorDiv.textContent?.includes("Syntax error in graph"), "error message must match");

  // Document body must not contain leaked error SVG
  assert.strictEqual(
    window.document.body.querySelector("svg"),
    null,
    "parse error must not leak error SVG into document.body",
  );

  errorRoot.unmount();
}

// 2. Two factories with different configs each render with their own config
async function testTwoFactoriesWithDifferentConfigs() {
  const window = await setupDom();
  const initHistory: Array<{ config: Record<string, unknown>; code: string }> = [];

  let currentConfig: Record<string, unknown> = {};
  const mockMermaid: MermaidModule = {
    initialize: (cfg) => {
      currentConfig = { ...cfg };
    },
    render: async (id, code) => {
      initHistory.push({ config: currentConfig, code });
      return {
        svg: `<svg id="${id}" data-theme="${String(currentConfig.theme)}"><text>${code}</text></svg>`,
      };
    },
  };
  __setMermaidModuleForTesting(mockMermaid);

  const FactoryDark = createMermaidBlock({
    config: { theme: "dark" },
    debounceMs: 0,
  });

  const FactoryForest = createMermaidBlock({
    config: { theme: "forest", securityLevel: "loose" },
    debounceMs: 0,
  });

  const container = window.document.getElementById("root");
  assert.ok(container, "root required");
  const root = createRoot(container);

  // Mount both factory instances concurrently
  root.render(
    React.createElement("div", null, [
      React.createElement(FactoryDark, {
        key: "dark",
        code: "graph TD; DarkNode;",
        renderCode: React.createElement("pre", null, "DarkNode"),
        language: "mermaid",
      }),
      React.createElement(FactoryForest, {
        key: "forest",
        code: "graph TD; ForestNode;",
        renderCode: React.createElement("pre", null, "ForestNode"),
        language: "mermaid",
      }),
    ]),
  );

  await waitFor(() => initHistory.length === 2);

  await waitFor(() => container.querySelectorAll("svg").length === 2);
  const darkExecution = initHistory.find((entry) => entry.code.includes("DarkNode"));
  const forestExecution = initHistory.find((entry) => entry.code.includes("ForestNode"));

  assert.ok(darkExecution, "dark factory render must be recorded");
  assert.ok(forestExecution, "forest factory render must be recorded");

  assert.strictEqual(darkExecution?.config.theme, "dark", "Dark factory must apply theme: dark");
  assert.strictEqual(
    darkExecution?.config.securityLevel,
    "strict",
    "Dark factory must retain securityLevel: strict by default",
  );
  assert.strictEqual(
    darkExecution?.config.suppressErrorRendering,
    true,
    "suppressErrorRendering must be true",
  );

  assert.strictEqual(forestExecution?.config.theme, "forest", "Forest factory must apply theme: forest");
  assert.strictEqual(
    forestExecution?.config.securityLevel,
    "loose",
    "Forest factory must allow explicit securityLevel: loose override",
  );
  assert.strictEqual(
    forestExecution?.config.suppressErrorRendering,
    true,
    "suppressErrorRendering must be true",
  );

  // Verify DOM contains rendered SVGs with respective data-theme
  const svgs = container.querySelectorAll("svg");
  assert.strictEqual(svgs.length, 2, "both SVGs should be in the DOM");
  const darkSvg = Array.from(svgs).find((s) => s.getAttribute("data-theme") === "dark");
  const forestSvg = Array.from(svgs).find((s) => s.getAttribute("data-theme") === "forest");
  assert.ok(darkSvg, "SVG rendered with dark theme must exist");
  assert.ok(forestSvg, "SVG rendered with forest theme must exist");

  root.unmount();
}

// 3. Custom errorComponent shown on parse error and retry re-renders
async function testCustomErrorComponentAndRetry() {
  const window = await setupDom();

  let shouldFail = true;
  let renderCallCount = 0;
  const mockMermaid: MermaidModule = {
    initialize: () => {},
    render: async (id, code) => {
      renderCallCount += 1;
      if (shouldFail) {
        throw new Error("Invalid diagram syntax at line 2");
      }
      return {
        svg: `<svg id="${id}" data-retry-success="true"><text>${code}</text></svg>`,
      };
    },
  };
  __setMermaidModuleForTesting(mockMermaid);

  let lastProps: MermaidErrorComponentProps | null = null;
  const CustomError: React.FC<MermaidErrorComponentProps> = (props) => {
    lastProps = props;
    return React.createElement(
      "div",
      { id: "custom-error-banner" },
      React.createElement("span", { id: "error-message" }, props.error),
      React.createElement("span", { id: "error-code" }, props.code),
      React.createElement("button", { id: "retry-button", type: "button", onClick: props.retry }, "Try Again"),
    );
  };

  const CustomBlock = createMermaidBlock({
    errorComponent: CustomError,
    debounceMs: 0,
  });

  const container = window.document.getElementById("root");
  assert.ok(container, "root required");
  const root = createRoot(container);

  root.render(
    React.createElement(CustomBlock, {
      code: "graph TD; Broken-->???",
      renderCode: React.createElement("pre", null, "broken"),
      language: "mermaid",
    }),
  );

  await waitFor(() => Boolean(container.querySelector("#custom-error-banner")));

  // Assert custom errorComponent is shown
  assert.strictEqual(renderCallCount, 1, "render should have been called once and failed");
  const errorBanner = container.querySelector("#custom-error-banner");
  assert.ok(errorBanner, "custom errorComponent must be mounted in DOM");

  const errMsg = container.querySelector("#error-message");
  assert.strictEqual(
    errMsg?.textContent,
    "Invalid diagram syntax at line 2",
    "errorComponent must receive error message",
  );

  const errCode = container.querySelector("#error-code");
  assert.strictEqual(
    errCode?.textContent,
    "graph TD; Broken-->???",
    "errorComponent must receive diagram code",
  );

  assert.ok(lastProps, "lastProps should be captured");
  assert.strictEqual(typeof lastProps?.retry, "function", "retry prop must be a function");

  // Ensure default error div is not present when custom errorComponent is provided
  assert.strictEqual(
    container.querySelector(".stream-mdx-mermaid-error"),
    null,
    "default error div should not be rendered when custom errorComponent is used",
  );

  // Ensure body didn't leak temporary error nodes
  assert.strictEqual(
    window.document.body.querySelector("svg[id*='mermaid']"),
    null,
    "parse error must not leak error elements into body",
  );

  // Fix the render failure and invoke retry
  shouldFail = false;
  const retryBtn = container.querySelector("#retry-button") as HTMLButtonElement | null;
  assert.ok(retryBtn, "retry button must be in DOM");
  retryBtn.click();

  await waitFor(() => Boolean(container.querySelector("svg[data-retry-success='true']")));

  // Assert that retry triggered a second render call and succeeded
  assert.strictEqual(renderCallCount, 2, "retry must re-render the diagram");
  assert.strictEqual(
    container.querySelector("#custom-error-banner"),
    null,
    "custom errorComponent must be unmounted after successful retry",
  );

  const successSvg = container.querySelector("svg[data-retry-success='true']");
  assert.ok(successSvg, "diagram SVG must be rendered after successful retry");
  assert.ok(
    container.textContent?.includes("graph TD; Broken-->???"),
    "SVG content must include the diagram code",
  );

  root.unmount();
}

async function main() {
  await testDefaultMermaidBlockUnchanged();
  console.log("✓ default MermaidBlock unchanged passed");

  await testTwoFactoriesWithDifferentConfigs();
  console.log("✓ two factories with different configs passed");

  await testCustomErrorComponentAndRetry();
  console.log("✓ custom errorComponent and retry passed");

  __setMermaidModuleForTesting(null);
}

await main();
