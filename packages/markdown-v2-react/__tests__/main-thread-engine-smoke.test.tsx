import assert from "node:assert";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { StreamingMarkdown } from "../src/streaming-markdown";

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

async function runMainThreadEngineSmokeTest(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "missing render root");

  const root = createRoot(container!);

  // Step 1: Initial streaming render with provisional paragraph
  root.render(
    <StreamingMarkdown
      engine="main-thread"
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

  // Step 2: Appended text reaching finalized DOM
  root.render(
    <StreamingMarkdown
      engine="main-thread"
      text={"# Main Thread Engine Heading\n\nInitial provisional paragraph.\n\nFinalized paragraph text reaching the DOM."}
    />,
  );

  await waitForMutation(container!, () => {
    return container!.textContent?.includes("Finalized paragraph text reaching the DOM.") ?? false;
  });

  assert.ok(
    container!.textContent?.includes("Finalized paragraph text reaching the DOM."),
    "appended text should reach finalized DOM",
  );

  const paragraphs = container!.querySelectorAll("p");
  assert.ok(paragraphs.length >= 2, "expected at least two paragraphs in finalized DOM");

  // Step 3: Clean unmount
  root.unmount();
}

await runMainThreadEngineSmokeTest();
console.log("main-thread engine smoke test passed");
