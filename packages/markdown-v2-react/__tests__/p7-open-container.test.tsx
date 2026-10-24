import assert from "node:assert/strict";
import { PATCH_ROOT_ID, type WorkerIn, type WorkerOut } from "@stream-mdx/core";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  defineContentComponent,
  type ContentComponentHostProps,
  type ContentComponentProps,
  type RendererStore,
  MarkdownRenderer,
  StreamingMarkdown,
  type StreamingMarkdownHandle,
} from "../src";
import { installTrustedNativeTestDom, waitFor, workerFactory } from "./trusted-native-fixture";

interface ThoughtViewProps {
  readonly title: string;
}

function ThoughtView({
  title,
  children,
  "data-component-status": status,
}: ThoughtViewProps & ContentComponentHostProps): React.ReactElement {
  return (
    <aside data-thought-title={title} data-component-status={status}>
      {children}
    </aside>
  );
}

const contentComponents = {
  ThoughtView: defineContentComponent<ThoughtViewProps>({
    component: ThoughtView,
    validateProps: (props: ContentComponentProps): props is ContentComponentProps & ThoughtViewProps =>
      typeof props.title === "string",
    renderWhen: "open",
  }),
};

const syntaxExtensionOptions = {
  syntax: {
    contractVersion: 1,
    containers: [{ name: "thought", component: "ThoughtView" }],
  },
} as const;
const OPEN_THOUGHT_SOURCE = ':::thought {"title":"Thinking"}\nReasoning **carefully**';

async function registeredOpenContainerRendersWhileStreaming(): Promise<void> {
  const restore = installTrustedNativeTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const handle = React.createRef<StreamingMarkdownHandle>();

  try {
    await act(async () => {
      root.render(
        <StreamingMarkdown
          {...syntaxExtensionOptions}
          ref={handle}
          worker={() => workerFactory()}
          engine="worker"
          contentPolicy="restricted"
          contentComponents={contentComponents}
          features={{ mdx: true, tables: false, html: false, math: false }}
          caret={false}
        />,
      );
    });
    await waitFor(() => handle.current?.getState().workerReady === true, "inline engine worker ready");

    await act(async () => {
      handle.current?.append("A prior paragraph.\n\n");
    });
    await waitFor(() => container.textContent?.includes("A prior paragraph.") === true, "paragraph separator reaches the public renderer");

    await act(async () => {
      handle.current?.append(OPEN_THOUGHT_SOURCE);
    });
    await waitFor(
      () => Boolean(container.querySelector('aside[data-thought-title="Thinking"]')),
      "registered thought component renders before a closing line arrives",
    );
    await act(async () => {
      await handle.current?.waitForIdle();
    });

    const thought = container.querySelector('aside[data-thought-title="Thinking"]');
    assert.ok(thought, "the registered component receives the literal JSON title");
    assert.equal(thought.getAttribute("data-component-status"), "open", "the host registration renders the still-open container");
    assert.equal(thought.querySelector("strong")?.textContent, "carefully", "the component receives native Markdown children");

    const authoredSource = handle.current?.getState().blocks
      .find((block) => block.payload.raw.includes(":::thought"))?.payload.raw;
    assert.equal(authoredSource, OPEN_THOUGHT_SOURCE, "the public block reader preserves the exact authored open-container source");
    await act(async () => {
      handle.current?.append("\n:::\n\nAfter thought.");
    });
    await waitFor(() => {
      const currentThought = container.querySelector('aside[data-thought-title="Thinking"]');
      const followingParagraph = Array.from(container.querySelectorAll("p"))
        .find((paragraph) => paragraph.textContent === "After thought.");
      return currentThought?.getAttribute("data-component-status") === "closed"
        && followingParagraph !== undefined
        && !currentThought.contains(followingParagraph);
    }, "the registered thought closes before following prose renders outside it");

    assert.equal(thought.getAttribute("data-component-status"), "closed", "the registered thought closes after its authored closer");
    assert.equal(thought.textContent, "Reasoning carefully", "the closed aside retains only its prior body");
    assert.equal(thought.querySelectorAll("strong").length, 1, "the prior body retains its native strong child");
    assert.equal(thought.textContent?.includes(":::"), false, "the literal closing fence is not rendered in the aside");

    const followingParagraph = Array.from(container.querySelectorAll("p"))
      .find((paragraph) => paragraph.textContent === "After thought.");
    assert.ok(followingParagraph, "the following prose renders as a paragraph");
    assert.equal(thought.contains(followingParagraph), false, "the following paragraph is outside the thought aside");

    const closedAuthoredSource = handle.current?.getState().blocks
      .find((block) => block.payload.raw.includes(":::thought"))?.payload.raw;
    assert.equal(
      closedAuthoredSource,
      ':::thought {"title":"Thinking"}\nReasoning **carefully**\n:::',
      "the public block reader preserves only the independently authored opener, body, and closer",
    );
    const MORE_THOUGHT_SOURCE = ':::thought {"title":"More"}\nFirst **inside**.\n\nSecond *inside*.';
    await act(async () => {
      handle.current?.append(`\n\n${MORE_THOUGHT_SOURCE}`);
    });
    await waitFor(
      () => Array.from(container.querySelectorAll("p")).some((paragraph) =>
        paragraph.textContent === "Second inside."
        && paragraph.querySelector("em")?.textContent === "inside"),
      "the second native paragraph with emphasis reaches the public renderer",
    );

    const secondMoreParagraph = Array.from(container.querySelectorAll("p"))
      .find((paragraph) => paragraph.textContent === "Second inside.");
    const moreThought = container.querySelector('aside[data-thought-title="More"]');
    assert.ok(secondMoreParagraph, "the second native paragraph is rendered");
    assert.ok(moreThought, "the separated registered thought renders");
    assert.equal(moreThought.getAttribute("data-component-status"), "open", "the second thought remains open");
    assert.equal(thought.getAttribute("data-component-status"), "closed", "the prior thought remains closed");
    assert.equal(moreThought.contains(thought), false, "the prior thought remains outside the new aside");
    assert.equal(thought.contains(moreThought), false, "the new thought remains outside the prior closed aside");
    assert.ok(followingParagraph, "following prose remains rendered");
    assert.equal(moreThought.contains(followingParagraph), false, "following prose remains outside the new aside");
    assert.equal(moreThought.contains(secondMoreParagraph), true, "the second paragraph belongs to the registered aside");

    const moreParagraphs = Array.from(moreThought.querySelectorAll("p"));
    assert.deepEqual(
      moreParagraphs.map((paragraph) => paragraph.textContent),
      ["First inside.", "Second inside."],
      "both body paragraphs render natively inside the new aside",
    );
    assert.equal(moreParagraphs[0]?.innerHTML, "First <strong>inside</strong>.", "the first paragraph retains its native strong child");
    assert.equal(moreParagraphs[1]?.innerHTML, "Second <em>inside</em>.", "the second paragraph retains its native emphasis child");

    const moreAuthoredSource = handle.current?.getState().blocks
      .find((block) => block.payload.raw.includes(':::thought {"title":"More"}'))?.payload.raw;
    assert.equal(
      moreAuthoredSource,
      MORE_THOUGHT_SOURCE,
      "the public block reader preserves the exact independent source across both body paragraphs",
    );
  } finally {
    await act(async () => root.unmount());
    restore();
  }
}

function findNativeCodeChildId(store: RendererStore): string | undefined {
  const pending = [...store.getChildren(PATCH_ROOT_ID)];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    if (store.getCodeBlock(id)) return id;
    pending.push(...store.getChildren(id));
  }
  return undefined;
}

async function registeredContainerNativeCodeChildKeepsPreparedLines(): Promise<void> {
  const renderer = new MarkdownRenderer({
    ...syntaxExtensionOptions,
    contentPolicy: "restricted",
    contentComponents,
    plugins: { mdx: true, tables: false, html: false, math: false },
  });
  const worker = workerFactory();
  const sentMessages: WorkerIn[] = [];
  const sendToWorker = worker.postMessage.bind(worker);
  Object.defineProperty(worker, "postMessage", {
    configurable: true,
    value(message: WorkerIn) {
      sentMessages.push(message);
      sendToWorker(message);
    },
  });

  let resolveInitialization!: (message: Extract<WorkerOut, { type: "INITIALIZED" }>) => void;
  let rejectInitialization!: (error: Error) => void;
  const initialized = new Promise<Extract<WorkerOut, { type: "INITIALIZED" }>>((resolve, reject) => {
    resolveInitialization = resolve;
    rejectInitialization = reject;
  });
  const observeWorker = (event: MessageEvent<WorkerOut>): void => {
    if (event.data.type === "INITIALIZED") resolveInitialization(event.data);
    else if (event.data.type === "ERROR") rejectInitialization(new Error(event.data.error.message));
  };
  worker.addEventListener("message", observeWorker);

  try {
    renderer.attachWorker(worker);
    const initializedMessage = await initialized;
    const initMessage = sentMessages.find(
      (message): message is Extract<WorkerIn, { type: "INIT" }> => message.type === "INIT",
    );
    assert.ok(initMessage, "the public renderer sends a typed INIT to the real worker");
    assert.deepEqual(initMessage.syntax, syntaxExtensionOptions.syntax);
    assert.deepEqual(initMessage.contentComponents, [{ name: "ThoughtView", renderWhen: "open" }]);
    assert.equal(initializedMessage.snapshot.inputSource?.raw, "", "the real worker publishes its canonical INIT baseline");

    const store = renderer.getStore();
    const source = [
      ':::thought {"title":"Code owner"}',
      "Prose before the code.",
      "",
      "```ts",
      "const first = 1;",
      "const second = 2;",
      "",
    ].join("\n");
    renderer.append(source);
    await waitFor(
      () => store.getBlocks().some((block) => block.payload.raw.includes("const second = 2;")),
      "the public cold source includes the completed second code line",
    );

    const codeId = findNativeCodeChildId(store);
    assert.ok(codeId, "the canonical root store exposes the registered container's native code child");
    const initialCode = store.getCodeBlock(codeId);
    assert.ok(initialCode, "the native code child exposes its prepared source");
    assert.equal(initialCode.source.state, "open");
    assert.equal(initialCode.source.lineCount, 2);
    const initialLines = store.getCodeLines(codeId, 0, initialCode.source.lineCount);
    assert.deepEqual(initialLines.map((line) => line.text), ["const first = 1;", "const second = 2;"]);
    assert.deepEqual(initialLines.map((line) => line.ending), ["\n", "\n"]);
    assert.ok(initialLines.every((line) => !line.isProvisional), "both authored code lines are complete");
    const firstLine = initialLines[0];
    assert.ok(firstLine);

    const thirdLine = "const p7PreparedChildThird = 3;";
    renderer.append(`${thirdLine}\n`);
    await waitFor(
      () => store.getBlocks().some((block) => block.payload.raw.includes(thirdLine)),
      "the public cold source includes the appended third code line",
    );

    const updatedCodeId = findNativeCodeChildId(store);
    assert.ok(updatedCodeId, "the canonical root store retains the native code child after append");
    const updatedCode = store.getCodeBlock(updatedCodeId);
    assert.ok(updatedCode, "the native code child retains its prepared source after append");
    assert.equal(updatedCode.source.state, "open");
    assert.equal(updatedCode.source.lineCount, 3);
    const updatedLines = store.getCodeLines(updatedCodeId, 0, updatedCode.source.lineCount);
    assert.deepEqual(
      updatedLines.map((line) => line.text),
      ["const first = 1;", "const second = 2;", thirdLine],
    );
    assert.deepEqual(updatedLines.map((line) => line.ending), ["\n", "\n", "\n"]);
    assert.ok(updatedLines.every((line) => !line.isProvisional), "the appended source line is complete");
    assert.strictEqual(updatedLines[0], firstLine, "append retains the first prepared code-line record identity");
  } finally {
    worker.removeEventListener("message", observeWorker);
    renderer.detachWorker({ terminate: true });
  }
}

await registeredOpenContainerRendersWhileStreaming();
await registeredContainerNativeCodeChildKeepsPreparedLines();
console.log("p7 open container test passed");
