import assert from "node:assert/strict";
import type { Block, InlineNode } from "@stream-mdx/core";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { AnimationTimeline, STREAM_MDX_ANIMATION_CSS } from "../src/animation";
import { MarkdownBlocksRenderer } from "../src/renderer/blocks-renderer";
import { createRendererStore } from "../src/renderer/store";
import { MarkdownBlocksRenderer as ServerMarkdownBlocksRenderer } from "../src/server";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const target = globalThis as unknown as Record<string, unknown>;
  target.IS_REACT_ACT_ENVIRONMENT = true;
  target.window = window;
  target.document = window.document;
  target.HTMLElement = window.HTMLElement;
  target.Node = window.Node;
  target.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  target.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  return window;
}

function makeStreamingParagraph(id: string, text: string): Block {
  return {
    id,
    type: "paragraph",
    isFinalized: false,
    payload: {
      raw: text,
      inline: [{ kind: "text", text }] satisfies InlineNode[],
      meta: { inlineStatus: "anticipated" },
    },
  };
}

function makeFinalizedParagraph(id: string, text: string): Block {
  return {
    id,
    type: "paragraph",
    isFinalized: true,
    payload: {
      raw: text,
      inline: [{ kind: "text", text }] satisfies InlineNode[],
      meta: {},
    },
  };
}

async function testOffByDefault(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root")!;
  const root = createRoot(container);

  const block = makeStreamingParagraph("p-off", "Hello streaming world");
  const store = createRendererStore([block]);

  await act(async () => {
    root.render(<MarkdownBlocksRenderer store={store} blocks={[block]} />);
  });
  await sleep(20);

  const spans = container.querySelectorAll(".stream-mdx-anim");
  assert.equal(spans.length, 0, "off by default must not emit any stream-mdx-anim spans");
  assert.equal(container.textContent, "Hello streaming world");
  assert.equal(container.children.length, 1);
  const renderer = container.querySelector<HTMLDivElement>(".markdown-renderer");
  assert.ok(renderer);
  assert.equal(renderer.tagName, "DIV");
  assert.equal(renderer.parentElement, container);
  assert.equal(renderer.getAttribute("class"), "markdown-renderer");
  assert.equal(renderer.style.getPropertyValue("contain"), "content");
  assert.equal(renderer.children.length, 1);
  const paragraph = renderer.firstElementChild;
  assert.ok(paragraph);
  assert.equal(paragraph.tagName, "P");
  assert.equal(paragraph.getAttribute("class"), "markdown-paragraph streaming-partial");
  assert.equal(paragraph.textContent, "Hello streaming world");
  assert.equal(paragraph.childElementCount, 0, "plain text must remain unformatted when animation is disabled");

  await act(async () => {
    root.unmount();
  });
}

async function testOnIdentityRetention(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root")!;
  const root = createRoot(container);

  const block1 = makeStreamingParagraph("p-on", "Hello world");
  const store = createRendererStore([block1]);

  await act(async () => {
    root.render(<MarkdownBlocksRenderer store={store} blocks={[block1]} animated={true} />);
  });
  await sleep(20);

  const spansBefore = Array.from(container.querySelectorAll<HTMLSpanElement>(".stream-mdx-anim"));
  assert.equal(spansBefore.length, 2, "expected 2 word spans initially");
  assert.equal(spansBefore[0].textContent, "Hello ");
  assert.equal(spansBefore[1].textContent, "world");

  // CSS variables presence check
  assert.ok(spansBefore[0].style.getPropertyValue("--sm-anim-duration").includes("150ms"));
  assert.ok(spansBefore[0].style.getPropertyValue("--sm-anim-easing").includes("ease-out"));
  assert.ok(spansBefore[0].style.getPropertyValue("--sm-anim-delay").includes("0ms"));
  assert.ok(spansBefore[1].style.getPropertyValue("--sm-anim-delay").includes("20ms"));

  const span0_before = spansBefore[0];
  const span1_before = spansBefore[1];

  // Append new words in next update
  const block2 = makeStreamingParagraph("p-on", "Hello world how are you");
  await act(async () => {
    store.applyPatches([
      {
        op: "setProps",
        at: { blockId: "p-on", nodeId: "p-on" },
        props: { block: block2 },
      },
    ]);
    root.render(<MarkdownBlocksRenderer store={store} blocks={[block2]} animated={true} />);
    await sleep(30);
  });

  const spansAfter = Array.from(container.querySelectorAll<HTMLSpanElement>(".stream-mdx-anim"));
  assert.equal(spansAfter.length, 5, "expected 5 word spans after appending 3 words");

  // DOM node identity check across re-renders
  assert.strictEqual(spansAfter[0], span0_before, "first word span DOM node must retain object identity");
  assert.strictEqual(spansAfter[1], span1_before, "second word span DOM node must retain object identity");
  assert.equal(spansAfter[1].textContent, "world ");

  // Newly mounted spans
  assert.equal(spansAfter[2].textContent, "how ");
  assert.equal(spansAfter[3].textContent, "are ");
  assert.equal(spansAfter[4].textContent, "you");

  await act(async () => {
    root.unmount();
  });
}

async function testSepChar(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root")!;
  const root = createRoot(container);

  const block1 = makeStreamingParagraph("p-char", "Hi");
  const store = createRendererStore([block1]);

  await act(async () => {
    root.render(<MarkdownBlocksRenderer store={store} blocks={[block1]} animated={{ sep: "char" }} />);
  });
  await sleep(20);

  const charsBefore = Array.from(container.querySelectorAll<HTMLSpanElement>(".stream-mdx-anim"));
  assert.equal(charsBefore.length, 2, "sep char must split into 2 character spans");
  assert.equal(charsBefore[0].textContent, "H");
  assert.equal(charsBefore[1].textContent, "i");

  const char0_before = charsBefore[0];
  const char1_before = charsBefore[1];

  // Append character
  const block2 = makeStreamingParagraph("p-char", "Hi!");
  await act(async () => {
    store.applyPatches([
      {
        op: "setProps",
        at: { blockId: "p-char", nodeId: "p-char" },
        props: { block: block2 },
      },
    ]);
    root.render(<MarkdownBlocksRenderer store={store} blocks={[block2]} animated={{ sep: "char" }} />);
    await sleep(30);
  });

  const charsAfter = Array.from(container.querySelectorAll<HTMLSpanElement>(".stream-mdx-anim"));
  assert.equal(charsAfter.length, 3, "expected 3 character spans after appending '!'");
  assert.strictEqual(charsAfter[0], char0_before, "char 0 DOM node identity must be preserved");
  assert.strictEqual(charsAfter[1], char1_before, "char 1 DOM node identity must be preserved");
  assert.equal(charsAfter[2].textContent, "!");

  await act(async () => {
    root.unmount();
  });
}

async function testFinalizedAndSsrNoSpans(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root")!;
  const root = createRoot(container);

  // 1. Finalized block on client
  const finalizedBlock = makeFinalizedParagraph("p-final", "Finalized plain text");
  const store = createRendererStore([finalizedBlock]);

  await act(async () => {
    root.render(<MarkdownBlocksRenderer store={store} blocks={[finalizedBlock]} animated={true} />);
  });
  await sleep(20);

  const spans = container.querySelectorAll(".stream-mdx-anim");
  assert.equal(spans.length, 0, "finalized block must contain no stream-mdx-anim spans");
  assert.equal(container.textContent, "Finalized plain text");

  await act(async () => {
    root.unmount();
  });

  // 2. SSR render with ServerMarkdownBlocksRenderer
  const streamingBlock = makeStreamingParagraph("p-ssr", "SSR streaming text");
  const ssrMarkup = renderToStaticMarkup(
    <ServerMarkdownBlocksRenderer blocks={[streamingBlock]} animated={true} />,
  );

  assert.ok(!ssrMarkup.includes("stream-mdx-anim"), "SSR output must not contain stream-mdx-anim spans");
  assert.ok(!ssrMarkup.includes("--sm-anim-"), "SSR output must not contain animation CSS variables");
  assert.ok(ssrMarkup.includes("SSR streaming text"), "SSR output must contain the plain text");
}

async function testTwoBlocksIsolation(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root")!;
  const root = createRoot(container);

  const block1 = makeStreamingParagraph("b1", "Alpha beta");
  const block2 = makeStreamingParagraph("b2", "Gamma delta");
  const store = createRendererStore([block1, block2]);

  await act(async () => {
    root.render(<MarkdownBlocksRenderer store={store} blocks={[block1, block2]} animated={true} />);
  });
  await sleep(20);

  const spansBefore = Array.from(container.querySelectorAll<HTMLSpanElement>(".stream-mdx-anim"));
  assert.equal(spansBefore.length, 4, "expected 4 words across 2 blocks");
  const b1_w0 = spansBefore[0];
  const b1_w1 = spansBefore[1];
  const b2_w0 = spansBefore[2];
  const b2_w1 = spansBefore[3];

  assert.equal(b1_w0.textContent, "Alpha ");
  assert.equal(b2_w0.textContent, "Gamma ");

  // Update ONLY block 2
  const block2_updated = makeStreamingParagraph("b2", "Gamma delta epsilon");
  await act(async () => {
    store.applyPatches([
      {
        op: "setProps",
        at: { blockId: "b2", nodeId: "b2" },
        props: { block: block2_updated },
      },
    ]);
    root.render(<MarkdownBlocksRenderer store={store} blocks={[block1, block2_updated]} animated={true} />);
    await sleep(30);
  });

  const spansAfter = Array.from(container.querySelectorAll<HTMLSpanElement>(".stream-mdx-anim"));
  assert.equal(spansAfter.length, 5, "expected 5 words total after appending to block 2");

  // Block 1 spans untouched
  assert.strictEqual(spansAfter[0], b1_w0, "block 1 word 0 DOM node preserved");
  assert.strictEqual(spansAfter[1], b1_w1, "block 1 word 1 DOM node preserved");

  // Block 2 spans preserved + 1 new span
  assert.strictEqual(spansAfter[2], b2_w0, "block 2 word 0 DOM node preserved");
  assert.strictEqual(spansAfter[3], b2_w1, "block 2 word 1 DOM node preserved");
  assert.equal(spansAfter[4].textContent, "epsilon");

  await act(async () => {
    root.unmount();
  });
}

function testLargeBurstBacklogCap(): void {
  const timeline = new AnimationTimeline({ now: () => 0, maxBacklogMs: 320, stagger: 20 });
  const delays = timeline.schedule(1000);
  assert.equal(delays.length, 1000, "large bursts must retain every segment");
  assert.equal(delays[0], 0);
  assert.equal(delays[999], 320, "1000 segments must fit within the configured backlog");
  assert.ok(delays.every((delay, index) => delay >= 0 && delay <= 320 && (index === 0 || delay >= delays[index - 1])), "compressed delays must stay ordered and within the cap");
  const following = timeline.schedule(1000);
  assert.ok(following.every((delay) => delay === 320), "a second burst in the same pass must not extend the backlog");
  timeline.commitPass();
  const nextPass = timeline.schedule(1000, 20, 100);
  assert.equal(nextPass[0], 220, "next pass must retain the preceding timeline order");
  assert.equal(nextPass[999], 320, "next pass must also respect its backlog cap");
  timeline.commitPass();
  const drained = timeline.schedule(3, 20, 1000);
  assert.deepEqual(drained, [0, 20, 40], "normal stagger must resume once the backlog drains");
  const instant = new AnimationTimeline({ now: () => 0, maxBacklogMs: 0 });
  assert.deepEqual(instant.schedule(3), [0, 0, 0], "zero backlog must reveal all segments immediately");
  assert.match(STREAM_MDX_ANIMATION_CSS, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/, "compressed scheduling must retain the reduced-motion override");
}

async function testLargeBurstRendering(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root")!;
  const root = createRoot(container);
  const text = Array.from({ length: 1000 }, (_, index) => `word${index}`).join(" ");
  const block = makeStreamingParagraph("p-burst", text);
  const store = createRendererStore([block]);
  await act(async () => {
    root.render(<MarkdownBlocksRenderer store={store} blocks={[block]} animated={{ maxBacklogMs: 320 }} />);
  });
  const spans = Array.from(container.querySelectorAll<HTMLSpanElement>(".stream-mdx-anim"));
  assert.equal(spans.length, 1000);
  assert.equal(container.textContent, text, "compressed animation must not drop or reorder content");
  const delays = spans.map((span) => Number.parseFloat(span.style.getPropertyValue("--sm-anim-delay")));
  assert.ok(delays.every((delay, index) => delay >= 0 && delay <= 320 && (index === 0 || delay >= delays[index - 1])), "rendered segment delays must stay ordered within maxBacklogMs");
  await act(async () => { root.unmount(); });
}

async function runAllTests(): Promise<void> {
  testLargeBurstBacklogCap();
  await testOffByDefault();
  await testOnIdentityRetention();
  await testSepChar();
  await testFinalizedAndSsrNoSpans();
  await testTwoBlocksIsolation();
  await testLargeBurstRendering();
  console.log("All animated streaming tests passed successfully!");
}

await runAllTests();
