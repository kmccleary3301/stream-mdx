import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createRef } from "react";
import type { AppendResult, StreamingMarkdownHandle } from "../src";
import { createRoot } from "react-dom/client";
import { StreamingMarkdown } from "../src/streaming-markdown";

const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  pretendToBeVisual: true,
});
const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
};
const previousGlobals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

// Bound lexical words while forcing admission offers to split non-BMP source.
const body = `aa${`${"🙂".repeat(1_024)} `.repeat(137)}z`;
const sentinel = "Stream EOF sentinel";
const errors: Error[] = [];
const handle = createRef<StreamingMarkdownHandle>();
let resolveError!: () => void;
const errorObserved = new Promise<void>((resolve) => {
  resolveError = resolve;
});

async function* stream(): AsyncGenerator<string> {
  yield body;
  yield `\n\n# ${sentinel}\n`;
}

function waitForRenderOutcome(container: HTMLElement, isComplete: () => boolean): Promise<"rendered" | "error"> {
  return new Promise((resolve, reject) => {
    const window = container.ownerDocument.defaultView;
    assert.ok(window, "missing JSDOM window");
    const observer = new window.MutationObserver(check);
    const timeout = setTimeout(() => {
      const actual = container.querySelector("p")?.textContent ?? "";
      let firstDifference = 0;
      while (firstDifference < actual.length && actual.charCodeAt(firstDifference) === body.charCodeAt(firstDifference)) firstDifference++;
      const blocks = handle.current?.getState().blocks.map((block) => ({
        type: block.type, units: block.payload.raw.length, finalized: block.isFinalized,
      }));
      observer.disconnect();
      reject(new Error(`large iterator EOF: paragraph ${actual.length}/${body.length}, first difference ${firstDifference}, ` +
        `heading ${container.querySelector("h1")?.textContent}, caret ${Boolean(container.querySelector(".stream-mdx-caret"))}, blocks ${JSON.stringify(blocks)}`));
    }, 5_000);
    const finish = (result: "rendered" | "error") => {
      observer.disconnect();
      clearTimeout(timeout);
      resolve(result);
    };
    function check(): void {
      if (isComplete()) finish("rendered");
    }
    observer.observe(container, { childList: true, subtree: true, characterData: true, attributes: true });
    void errorObserved.then(() => finish("error"));
    check();
  });
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
async function runInAct(callback: () => void): Promise<void> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  try {
    await act(callback);
  } finally {
    if (previous) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  }
}

const container = dom.window.document.getElementById("root");
assert.ok(container, "missing render root");
const root = createRoot(container);
try {
  await runInAct(() => {
    root.render(
      <StreamingMarkdown
        ref={handle}
        engine="main"
        stream={stream()}
        caret="block"
        onError={(error) => {
          errors.push(error);
          resolveError();
        }}
      />,
    );
  });

  const outcome = await waitForRenderOutcome(container, () => {
    const paragraph = container.querySelector("p");
    const heading = container.querySelector("h1");
    return paragraph?.textContent === body && heading?.textContent?.trim() === sentinel &&
      container.querySelector(".stream-mdx-caret") === null;
  });

  assert.equal(outcome, "rendered", errors[0]?.message ?? "expected the source to render through EOF");
  assert.deepEqual(errors, [], "large iterator input must not surface a source capacity error");

  const paragraph = container.querySelector("p");
  const heading = container.querySelector("h1");
  assert.equal(paragraph?.textContent, body, "the first paragraph must preserve every input code unit");
  assert.equal(heading?.textContent?.trim(), sentinel, "the following iterator chunk must render its heading");
  assert.ok(paragraph && heading, "expected the body paragraph and EOF sentinel heading");
  assert.notEqual(
    paragraph.compareDocumentPosition(heading) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    0,
    "the sentinel heading must follow the large body paragraph",
  );
  assert.equal(container.querySelector(".stream-mdx-caret"), null, "rendered EOF must release the caret");
  const restartPrefix = "Fresh restarted session: ";
  const expectedRestartSource = `${restartPrefix}${"x".repeat(65_536 - restartPrefix.length)}`;
  assert.equal(expectedRestartSource.length, 65_536, "the restart append meets the admission soft limit exactly");

  const currentHandle = handle.current;
  assert.ok(currentHandle, "the real StreamingMarkdown handle is mounted");
  let appendResult!: AppendResult;
  let capacityWait!: Promise<void>;
  await runInAct(() => {
    currentHandle.restart();
    appendResult = currentHandle.append(expectedRestartSource);
    capacityWait = currentHandle.waitForCapacity({ units: 0 });
  });

  assert.equal(appendResult.acceptedSourceUnits, expectedRestartSource.length);
  assert.equal(appendResult.pendingSourceUnits, expectedRestartSource.length);
  assert.equal(appendResult.shouldPause, true, "the exact soft-limit append requests a capacity wait");

  await waitFor(
    () => !container.textContent?.includes(body) && !container.textContent?.includes(sentinel),
    "the restarted React session commits before awaiting the capacity promise",
  );
  await capacityWait;

  const restartedHandle = handle.current;
  assert.ok(restartedHandle, "the restarted StreamingMarkdown handle remains mounted");
  const finalization = await restartedHandle.finalize();
  assert.equal(finalization.acceptedSourceUnits, expectedRestartSource.length,
    "finalization reports every unit accepted into the restarted public session");
  assert.equal(finalization.committedSourceUnits, expectedRestartSource.length,
    "the restarted public session commits every accepted source unit");
  await waitForRenderOutcome(container, () => container.querySelector("p")?.textContent === expectedRestartSource);
  assert.equal(container.querySelector("p")?.textContent, expectedRestartSource,
    "the actual rendered paragraph preserves the complete new authored source");
  assert.equal(container.querySelectorAll("p").length, 1, "the restarted source is rendered exactly once");
  assert.equal(container.querySelector("h1"), null, "the previous generation's EOF sentinel stays cleared");
  assert.deepEqual(errors, [], "restart admission and capacity waiting do not report an error");

} finally {
  await runInAct(() => root.unmount());
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.window.close();
}

console.log("large iterator chunk admission test passed");
