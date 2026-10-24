import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  defineContentComponent,
  type AppendResult,
  type ContentComponentHostProps,
  type ContentComponentProps,
  StreamingMarkdown,
  type StreamingMarkdownHandle,
} from "../src";
import { installTrustedNativeTestDom, waitFor, workerFactory } from "./trusted-native-fixture";

interface ContainerProps {
  readonly title?: string;
}

function ContainerView({
  title,
  children,
  "data-component-status": status,
  "data-diagnostic": diagnostic,
}: ContainerProps & ContentComponentHostProps): React.ReactElement {
  return (
    <aside data-container-title={title ?? ""} data-component-status={status} data-diagnostic={diagnostic}>
      {children}
    </aside>
  );
}

const contentComponents = {
  ContainerView: defineContentComponent<ContainerProps>({
    component: ContainerView,
    validateProps: (props: ContentComponentProps): props is ContentComponentProps & ContainerProps =>
      props.title === undefined || typeof props.title === "string",
    renderWhen: "open",
  }),
};

const syntax = {
  contractVersion: 1,
  containers: [
    { name: "outer", component: "ContainerView" },
    { name: "inner", component: "ContainerView" },
    { name: "thought", component: "ContainerView" },
    { name: "name", component: "ContainerView" },
  ],
} as const;

async function withMarkdown(
  run: (container: HTMLDivElement, handle: React.RefObject<StreamingMarkdownHandle | null>) => Promise<void>,
): Promise<void> {
  const restore = installTrustedNativeTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const handle = React.createRef<StreamingMarkdownHandle>();
  try {
    await act(async () => {
      root.render(
        <StreamingMarkdown
          ref={handle}
          worker={() => workerFactory()}
          engine="worker"
          contentPolicy="restricted"
          contentComponents={contentComponents}
          syntax={{ ...syntax }}
          features={{ mdx: true, tables: false, html: false, math: false }}
          caret={false}
        />,
      );
    });
    await waitFor(() => handle.current?.getState().workerReady === true, "container rules worker ready");
    await run(container, handle);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
}

async function appendAndIdle(handle: React.RefObject<StreamingMarkdownHandle | null>, text: string): Promise<void> {
  await act(async () => {
    handle.current?.append(text);
    await handle.current?.waitForIdle();
  });
}

async function nestedContainersCloseInnermostFirst(): Promise<void> {
  await withMarkdown(async (container, handle) => {
    await appendAndIdle(
      handle,
      [
        ':::outer {"title":"outer"}',
        "Outer before.",
        "",
        ':::inner {"title":"inner"}',
        "Inner body.",
        ":::",
        "Outer after.",
        ":::",
      ].join("\n"),
    );
    await waitFor(
      () => container.querySelector('aside[data-container-title="outer"]') !== null,
      "outer registered container rendered",
    );
    const outer = container.querySelector<HTMLElement>('aside[data-container-title="outer"]');
    const inner = container.querySelector<HTMLElement>('aside[data-container-title="inner"]');
    assert.ok(outer, "the outer three-colon container renders");
    assert.ok(inner, "the nested three-colon container renders");
    assert.equal(outer.getAttribute("data-component-status"), "closed");
    assert.equal(inner.getAttribute("data-component-status"), "closed");
    assert.equal(outer.contains(inner), true, "the inner container remains nested in its outer owner");
    assert.match(outer.textContent ?? "", /Outer before\..*Outer after\./s);
    assert.equal(inner.textContent, "Inner body.");
  });
}
async function nestedContainerRetainsChildParagraphs(): Promise<void> {
  await withMarkdown(async (container, handle) => {
    await appendAndIdle(
      handle,
      [
        "::::outer",
        "",
        ":::inner",
        "First paragraph.",
        "",
        "Second paragraph.",
        ":::",
        "",
        "Outer after.",
        "::::",
      ].join("\n"),
    );
    await waitFor(
      () => container.querySelector('aside[data-component-status="closed"]') !== null,
      "the outer container closes",
    );
    const [outer, inner] = Array.from(container.querySelectorAll<HTMLElement>("aside"));
    assert.ok(outer, "the outer container renders");
    assert.ok(inner, "the inner container renders");
    assert.equal(outer.contains(inner), true, "the inner container remains nested in the outer owner");
    assert.equal(inner.textContent, "First paragraph.\n\nSecond paragraph.");
    assert.match(outer.textContent ?? "", /Outer after\./);
    assert.doesNotMatch(container.textContent ?? "", /:{3}/, "container delimiters do not leak as text");
  });
}

async function differentLengthNestedContainersCloseIndependently(): Promise<void> {
  await withMarkdown(async (container, handle) => {
    await appendAndIdle(
      handle,
      [
        '::::outer {"title":"outer"}',
        "",
        ':::inner {"title":"inner"}',
        "Inner body.",
        ":::",
        "",
        "Outer after.",
        "::::",
      ].join("\n"),
    );
    await waitFor(
      () => container.querySelector('aside[data-container-title="outer"]')?.getAttribute("data-component-status") === "closed",
      "the four-colon outer container closes",
    );
    const outer = container.querySelector<HTMLElement>('aside[data-container-title="outer"]');
    const inner = container.querySelector<HTMLElement>('aside[data-container-title="inner"]');
    assert.ok(outer, "the four-colon outer container renders");
    assert.ok(inner, "the nested three-colon container renders");
    assert.equal(outer.getAttribute("data-component-status"), "closed");
    assert.equal(inner.getAttribute("data-component-status"), "closed");
    assert.equal(outer.contains(inner), true, "the inner container remains nested in its outer owner");
    assert.equal(inner.textContent, "Inner body.");
    assert.match(outer.textContent ?? "", /Outer after\./);
  });
}

async function longerCloserDoesNotCloseShorterContainer(): Promise<void> {
  await withMarkdown(async (container, handle) => {
    await appendAndIdle(
      handle,
      [':::outer {"title":"outer"}', ':::inner {"title":"inner"}', "Inner body.", "::::"].join("\n"),
    );
    await waitFor(
      () => container.querySelector('aside[data-container-title="inner"]') !== null,
      "the nested open container renders",
    );
    const inner = container.querySelector<HTMLElement>('aside[data-container-title="inner"]');
    assert.ok(inner, "the nested container renders");
    assert.equal(inner.getAttribute("data-component-status"), "open");
    assert.ok(inner.textContent?.includes("::::"), "a four-colon closer remains literal inside a three-colon container");
  });
}


async function unmatchedCloserStaysLiteral(): Promise<void> {
  await withMarkdown(async (container, handle) => {
    await appendAndIdle(handle, "Before.\n:::\n\n");
    await waitFor(
      () => container.textContent?.includes(":::") === true,
      "the unmatched closer is rendered literally",
    );
    assert.equal(container.querySelector("aside"), null, "an unmatched closer does not create a container");
    assert.ok(container.textContent?.includes(":::"), "an unmatched closer remains rendered as source text");
  });
}

async function fencedContainerHeaderStaysCode(): Promise<void> {
  await withMarkdown(async (container, handle) => {
    await appendAndIdle(handle, '```md\n:::thought {"title":"fenced"}\n```\n');
    await waitFor(
      () => container.querySelector("pre code")?.textContent?.includes(":::thought") === true,
      "container-looking source renders within fenced code",
    );
    assert.equal(container.querySelector("aside"), null, "container-looking code does not create a component");
    assert.ok(container.querySelector("pre code")?.textContent?.includes(":::thought"));
  });
}

async function containerHeaderNeedsParagraphSeparation(): Promise<void> {
  await withMarkdown(async (container, handle) => {
    await appendAndIdle(handle, 'Paragraph first.\n:::thought {"title":"No gap"}\nBody.\n:::\n\n');
    await waitFor(
      () => Array.from(container.querySelectorAll("p")).some((paragraph) => paragraph.textContent?.includes(":::thought")),
      "the unseparated header remains paragraph text",
    );
    assert.equal(container.querySelector("aside"), null, "a header attached to a paragraph is not admitted");
    assert.ok(container.querySelector("p")?.textContent?.includes(":::thought"));
  });
}

async function finalizingOpenContainerKeepsChildrenAndDiagnostic(): Promise<void> {
  await withMarkdown(async (container, handle) => {
    await appendAndIdle(handle, ':::thought {"title":"Final"}\nInside **children**');
    await waitFor(
      () => container.querySelector('aside[data-container-title="Final"]') !== null,
      "the open registered component renders before finalization",
    );
    const open = container.querySelector<HTMLElement>('aside[data-container-title="Final"]');
    assert.ok(open, "the open component renders before finalization");
    assert.equal(open.getAttribute("data-component-status"), "open");
    assert.ok(open.querySelector("strong")?.textContent === "children");

    await act(async () => {
      await handle.current?.finalize();
    });
    await waitFor(
      () => container.querySelector('aside[data-container-title="Final"]')?.getAttribute("data-component-status") === "incomplete",
      "finalization publishes the incomplete component state",
    );
    const finalized = container.querySelector<HTMLElement>('aside[data-container-title="Final"]');
    assert.ok(finalized, "finalization retains the registered component and its children");
    assert.equal(finalized.getAttribute("data-component-status"), "incomplete");
    assert.match(finalized.getAttribute("data-diagnostic") ?? "", /Unclosed container/);
    assert.equal(finalized.querySelector("strong")?.textContent, "children");
  });
}

async function partialOpeningLineWaitsForNewlineWithoutCommittedLiteral(): Promise<void> {
  await withMarkdown(async (container, handle) => {
    const observedBlocks: Array<{ raw: string; isFinalized: boolean }> = [];
    let acceptedSourceUnits = 0;
    for (const [chunk, expectedRaw] of [["::", "::"], [":na", ":::na"]] as const) {
      let appendResult: AppendResult | undefined;
      await act(async () => {
        appendResult = handle.current?.append(chunk);
        await handle.current?.waitForIdle();
      });
      acceptedSourceUnits += chunk.length;
      assert.equal(appendResult?.acceptedSourceUnits, acceptedSourceUnits, "each incomplete fragment remains accepted source");
      assert.equal(container.querySelector("aside"), null, "an incomplete opener is not admitted");
      const matching = handle.current?.getState().blocks.filter((block) => block.payload.raw.includes(expectedRaw)) ?? [];
      assert.ok(matching.every((block) => !block.isFinalized), "any partial opener block remains provisional");
      observedBlocks.push(...matching.map((block) => ({ raw: block.payload.raw, isFinalized: block.isFinalized })));
    }

    await appendAndIdle(handle, "me\n");
    await waitFor(
      () => container.querySelector("aside") !== null,
      "the completed opening line admits its registered container",
    );
    assert.equal(container.textContent, "", "the opener is replaced directly by the container, without literal text flicker");
    assert.ok(
      observedBlocks.every((block) => !block.isFinalized && block.raw.startsWith(":")),
      "only the provisional source contains the incomplete opener",
    );
    assert.equal(
      handle.current?.getState().blocks.some((block) => block.isFinalized && block.payload.raw.includes(":::name")),
      false,
      "no committed literal block retains the completed opener",
    );
  });
}

await unmatchedCloserStaysLiteral();
await fencedContainerHeaderStaysCode();
await containerHeaderNeedsParagraphSeparation();
await finalizingOpenContainerKeepsChildrenAndDiagnostic();
await partialOpeningLineWaitsForNewlineWithoutCommittedLiteral();
await nestedContainerRetainsChildParagraphs();
await differentLengthNestedContainersCloseIndependently();
await longerCloserDoesNotCloseShorterContainer();
console.log("p7 container rules test passed");
