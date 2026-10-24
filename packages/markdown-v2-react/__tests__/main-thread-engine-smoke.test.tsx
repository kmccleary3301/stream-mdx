import assert from "node:assert";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamingMarkdown } from "../src/streaming-markdown";
import type { StreamingMarkdownHandle, StreamingMarkdownProps } from "../src/streaming-markdown";
const validEngineMode: StreamingMarkdownProps["engine"] = "main";
// @ts-expect-error The removed engine mode must remain a public type error.
const retiredEngineMode: StreamingMarkdownProps["engine"] = "main-thread";
void validEngineMode;
void retiredEngineMode;


async function setupDom(): Promise<Window & typeof globalThis> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  (globalThis as any).window = window;
  (globalThis as any).document = window.document;
  (globalThis as any).HTMLElement = window.HTMLElement;
  (globalThis as any).Node = window.Node;
  (globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
  (globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  return window as unknown as Window & typeof globalThis;
}

function waitForMutation(container: HTMLElement, predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve) => {
    const observer = new (container.ownerDocument.defaultView as any).MutationObserver(() => {
      if (predicate()) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });
  });
}

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(10);
  }
}

function rejectsRetiredEngineMode(): void {
  assert.throws(
    () => renderToStaticMarkup(
      <StreamingMarkdown engine={"main-thread" as unknown as StreamingMarkdownProps["engine"]} />,
    ),
    /engine="main-thread" has been removed; use engine="main" instead/,
  );
}

rejectsRetiredEngineMode();


async function runMainThreadEngineSmokeTest(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "missing render root");

  const root = createRoot(container!);

  // Step 1: Initial streaming render with provisional paragraph
  root.render(
    <StreamingMarkdown
      engine="main"
      text={"# Main Thread Engine Heading\n\nInitial provisional paragraph."}
    />,
  );

  await waitForMutation(container!, () => {
    return (
      Boolean(container!.querySelector("h1")) &&
      (container!.textContent?.includes("Initial provisional paragraph.") ?? false)
    );
  });

  const heading1 = container!.querySelector("h1");
  assert.ok(heading1, "expected <h1> to be rendered on main-thread engine");
  assert.strictEqual(heading1.textContent?.trim(), "Main Thread Engine Heading");

  // Step 2: Replace the document through the public text prop.
  root.render(
    <StreamingMarkdown
      engine="main"
      text={"# Replacement engine heading\n\nReplacement paragraph reaching the DOM."}
    />,
  );

  await waitForMutation(container!, () => {
    return container!.textContent?.includes("Replacement paragraph reaching the DOM.") ?? false;
  });

  assert.strictEqual(container.querySelectorAll("h1").length, 1, "text replacement must not duplicate headings");
  assert.strictEqual(container.querySelector("h1")?.textContent?.trim(), "Replacement engine heading");
  assert.strictEqual(container.textContent?.includes("Main Thread Engine Heading"), false, "old heading must be gone");
  assert.strictEqual(container.textContent?.includes("Initial provisional paragraph."), false, "old paragraph must be gone");
  assert.strictEqual(container.querySelectorAll("p").length, 1, "only the replacement paragraph remains");

  // Step 3: Clean unmount
  root.unmount();
}

await runMainThreadEngineSmokeTest();
async function runAutoBootstrapBeforeWorkerReadiness(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: class {},
  });
  let workerFactoryCalls = 0;
  class NeverReadyWorker extends EventTarget implements Worker {
    onmessage: Worker["onmessage"] = null;
    onmessageerror: Worker["onmessageerror"] = null;
    onerror: Worker["onerror"] = null;
    postMessage: Worker["postMessage"] = () => {};
    terminate(): void {}
  }
  try {
    root.render(
      <StreamingMarkdown
        text="Short authored paragraph."
        worker={() => {
          workerFactoryCalls++;
          return new NeverReadyWorker();
        }}
        prewarmLangs={["python"]}
      />,
    );
    await waitForCondition(
      () => container.querySelector("p")?.textContent === "Short authored paragraph.",
      "auto must publish native paragraph DOM without waiting for a worker factory or language prewarm",
    );
    assert.equal(workerFactoryCalls, 0, "short auto messages do not start a worker");
  } finally {
    root.unmount();
    container.remove();
    if (previousWorker) Object.defineProperty(globalThis, "Worker", previousWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
    window.close();
  }
}

await runAutoBootstrapBeforeWorkerReadiness();

async function runAutoBootstrapUnitLimit(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  const handle = createRef<StreamingMarkdownHandle>();
  try {
    root.render(<StreamingMarkdown ref={handle} />);
    await waitForCondition(
      () => handle.current?.getState().workerReady === true,
      "auto inline owner did not become ready",
    );
    const prefix = "😀".repeat(2048);
    const result = handle.current!.append(`${prefix}x`);
    assert.equal(result.acceptedSourceUnits, 4097);
    await waitForCondition(
      () => container.querySelector("p")?.textContent?.length === 4096,
      "auto main-thread owner did not publish its 4096-unit prefix",
    );
    await delay(30);
    assert.equal(container.querySelector("p")?.textContent, prefix, "the inline owner must refuse units beyond 4096");
  } finally {
    root.unmount();
    container.remove();
    window.close();
  }
}

await runAutoBootstrapUnitLimit();


async function runCallbackUpdateDuringStream(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  const handle = createRef<StreamingMarkdownHandle>();
  try {
    flushSync(() => {
      root.render(<StreamingMarkdown ref={handle} engine="main" onError={() => {}} />);
    });
    const deadline = Date.now() + 10000;
    while (!handle.current?.getState().workerReady) {
      assert.ok(Date.now() < deadline, "inline engine did not become ready");
      await delay(5);
    }
    handle.current.append("# Retained heading\n\nBefore callback update.\n\n");
    await waitForMutation(container, () => container.textContent?.includes("Before callback update.") ?? false);
    flushSync(() => {
      root.render(<StreamingMarkdown ref={handle} engine="main" onError={() => {}} />);
    });
    await delay(30);
    handle.current?.append("After callback update.");
    await handle.current?.finalize();
    await waitForMutation(container, () => container.textContent?.includes("After callback update.") ?? false);
    assert.strictEqual(container.querySelector("h1")?.textContent, "Retained heading");
    assert.ok(container.textContent?.includes("Before callback update."));
  } finally {
    root.unmount();
  }
}

await runCallbackUpdateDuringStream();
console.log("main-thread engine smoke test passed");
