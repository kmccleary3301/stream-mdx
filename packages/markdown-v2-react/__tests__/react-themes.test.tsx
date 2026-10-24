import assert from "node:assert";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { StreamingMarkdown } from "../src/streaming-markdown";

async function setupDom(): Promise<Window & typeof globalThis> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const target = globalThis as unknown as Record<string, unknown>;
  target.window = window;
  target.document = window.document;
  target.HTMLElement = window.HTMLElement;
  target.Node = window.Node;
  target.DOMParser = window.DOMParser;
  target.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  target.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  return window as unknown as Window & typeof globalThis;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waitForMutation(container: HTMLElement, predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  if (predicate()) return Promise.resolve();
  const { promise, resolve, reject } = deferred<void>();
  const defaultView = container.ownerDocument.defaultView;
  const ObserverClass = defaultView?.MutationObserver ?? MutationObserver;
  let timer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;

  const cleanup = () => {
    clearInterval(timer);
    clearTimeout(timeoutTimer);
    observer.disconnect();
  };

  const check = () => {
    if (predicate()) {
      cleanup();
      resolve();
    }
  };

  const observer = new ObserverClass(() => {
    check();
  });
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  timer = setInterval(() => {
    check();
  }, 20);
  timeoutTimer = setTimeout(() => {
    cleanup();
    reject(new Error("waitForMutation timed out"));
  }, timeoutMs);
  return promise;
}

async function runReactThemesTest(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "missing render root");

  const root = createRoot(container);
  const code = "```javascript\nconst x = 1;\n```\n";

  try {
    // 1. Initial render with custom themes
    root.render(
      <StreamingMarkdown
        engine="main"
        text={code}
        themes={{ light: "min-light", dark: "nord" }}
      />,
    );

    await waitForMutation(container, () => {
      return container.innerHTML.includes("nord") || container.innerHTML.includes("min-light");
    });

    const htmlWithCustom = container.innerHTML;
    assert.ok(htmlWithCustom.includes("nord") && htmlWithCustom.includes("min-light"), "DOM must reflect custom nord and min-light themes");
    assert.ok(!htmlWithCustom.includes("github-dark"), "DOM must not contain default github-dark when custom themes are set");

    // 2. Change themes prop to default themes -> restarts / re-inits
    root.render(
      <StreamingMarkdown
        engine="main"
        text={code}
        themes={{ light: "github-light", dark: "github-dark" }}
      />,
    );

    await waitForMutation(container, () => {
      return container.innerHTML.includes("github-dark") && container.innerHTML.includes("github-light");
    });

    const htmlWithDefault = container.innerHTML;
    assert.ok(htmlWithDefault.includes("github-dark") && htmlWithDefault.includes("github-light"), "re-init must switch to github themes");
    assert.ok(!htmlWithDefault.includes("nord"), "re-init must remove nord theme classes");
  } finally {
    root.unmount();
  }
}

await runReactThemesTest();
console.log("react themes tests passed");
