import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert";
import React from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import type { SyntaxRuleSpec } from "@stream-mdx/core";
import { MarkdownEngine } from "@stream-mdx/worker/engine";
import { StreamingMarkdown } from "../src/streaming-markdown";

async function setupDom(): Promise<Window & typeof globalThis> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  (globalThis as unknown as Record<string, unknown>).window = window;
  (globalThis as unknown as Record<string, unknown>).document = window.document;
  (globalThis as unknown as Record<string, unknown>).HTMLElement = window.HTMLElement;
  (globalThis as unknown as Record<string, unknown>).Node = window.Node;
  (globalThis as unknown as Record<string, unknown>).DOMParser = window.DOMParser;
  (globalThis as unknown as Record<string, unknown>).requestAnimationFrame = window.requestAnimationFrame.bind(window);
  (globalThis as unknown as Record<string, unknown>).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  return window as unknown as Window & typeof globalThis;
}

/**
 * File-local deferred (Node 20 has no `Promise.withResolvers`) with the same resolve/reject
 * surface, so the observer and timeout settle the wait exactly as before.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waitForMutation(container: HTMLElement, predicate: () => boolean, timeoutMs = 5000): Promise<void> {
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
    reject(new Error(`Timed out after ${timeoutMs}ms waiting for mutation: ${predicate.toString()}\nContainer HTML:\n${container.innerHTML}`));
  }, timeoutMs);

  return promise;
}

async function testInvalidRegexYieldsErrorMessage(): Promise<void> {
  const errors: unknown[] = [];
  const engine = new MarkdownEngine({
    post: (msg) => {
      if (msg.type === "ERROR") {
        errors.push(msg);
      }
    },
  });

  await engine.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, syntax: [
    {
      name: "invalidRule",
      pattern: { source: "[unclosed-bracket(" },
    },
  ], });

  assert.ok(errors.length > 0, "expected an ERROR message for invalid regex pattern");
  const firstError = errors[0];
  assert.ok(firstError && typeof firstError === "object" && "type" in firstError && "phase" in firstError);
  assert.strictEqual(firstError.type, "ERROR");
  assert.strictEqual(firstError.phase, "INIT");
}

async function testSyntaxRuleStaticAndStreamedIdentical(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "missing render root");

  const ticketRule: SyntaxRuleSpec = {
    name: "ticket",
    pattern: { source: "#([A-Z]+-\\d+)" },
    attrs: { id: 1 },
  };

  const TicketComponent = ({ id }: { id?: string }) => (
    <span className="custom-ticket" data-ticket-id={id}>
      Ticket: {id}
    </span>
  );

  // 1. Static render
  const root = createRoot(container!);
  root.render(
    <StreamingMarkdown
      engine="main-thread"
      text="See issue #ABC-123 for details."
      syntax={[ticketRule]}
      inlineComponents={{ ticket: TicketComponent }}
    />,
  );

  await waitForMutation(container!, () => {
    return Boolean(container!.querySelector(".custom-ticket"));
  });

  const staticTicket = container!.querySelector(".custom-ticket");
  assert.ok(staticTicket, "expected custom ticket component in static render");
  assert.strictEqual(staticTicket.getAttribute("data-ticket-id"), "ABC-123");
  assert.strictEqual(staticTicket.textContent, "Ticket: ABC-123");
  const staticHtml = container!.innerHTML;
  root.unmount();

  // 2. Streamed render (1-char chunks via async iterable)
  container!.innerHTML = "";
  const streamedRoot = createRoot(container!);
  const fullText = "See issue #ABC-123 for details.";
  async function* generateOneCharChunks() {
    for (const char of fullText) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      yield char;
    }
  }

  streamedRoot.render(
    <StreamingMarkdown
      engine="main-thread"
      stream={generateOneCharChunks()}
      syntax={[ticketRule]}
      inlineComponents={{ ticket: TicketComponent }}
    />,
  );

  await waitForMutation(container!, () => {
    return (
      Boolean(container!.querySelector(".custom-ticket")) &&
      (container!.textContent?.includes("for details.") ?? false)
    );
  });

  const streamedTicket = container!.querySelector(".custom-ticket");
  assert.ok(streamedTicket, "expected custom ticket component in streamed render");
  assert.strictEqual(streamedTicket.getAttribute("data-ticket-id"), "ABC-123");
  assert.strictEqual(streamedTicket.textContent, "Ticket: ABC-123");
  const streamedHtml = container!.innerHTML;
  assert.strictEqual(staticHtml, streamedHtml, "static and streamed output must be identical");
  streamedRoot.unmount();
}

async function testSyntaxRuleNestedInBold(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "missing render root");

  const ticketRule: SyntaxRuleSpec = {
    name: "ticket",
    pattern: { source: "#([A-Z]+-\\d+)" },
    attrs: { id: 1 },
  };

  const TicketComponent = ({ id }: { id?: string }) => (
    <span className="nested-ticket" data-id={id}>
      [{id}]
    </span>
  );

  const root = createRoot(container!);
  root.render(
    <StreamingMarkdown
      engine="main-thread"
      text="This is **bold #ABC-1** text."
      syntax={[ticketRule]}
      inlineComponents={{ ticket: TicketComponent }}
    />,
  );

  await waitForMutation(container!, () => {
    return Boolean(container!.querySelector("strong .nested-ticket"));
  });

  const nestedTicket = container!.querySelector("strong .nested-ticket");
  assert.ok(nestedTicket, "expected ticket component nested inside <strong>");
  assert.strictEqual(nestedTicket.getAttribute("data-id"), "ABC-1");
  root.unmount();
}

async function testAllowedTagsAndHtmlElements(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "missing render root");

  const KbdComponent = (props: React.HTMLAttributes<HTMLElement>) => (
    <kbd className="mapped-kbd" data-mapped="true" {...props}>
      {props.children}
    </kbd>
  );

  const root = createRoot(container!);
  root.render(
    <StreamingMarkdown
      engine="main-thread"
      text='Press <kbd data-x="1" bad="forbidden" data-unlisted="no">Ctrl+C</kbd> to copy.'
      html={{
        allowedTags: {
          kbd: ["data-x"],
        },
      }}
      htmlElements={{
        kbd: KbdComponent,
      }}
    />,
  );

  await waitForMutation(container!, () => {
    return Boolean(container!.querySelector("kbd"));
  });

  const kbd = container!.querySelector("kbd");
  assert.ok(kbd, "expected <kbd> element to be rendered");
  assert.strictEqual(kbd.getAttribute("data-x"), "1", "data-x attribute must be preserved");
  assert.strictEqual(kbd.getAttribute("bad"), null, "unlisted 'bad' attribute must be stripped");
  assert.strictEqual(kbd.getAttribute("data-unlisted"), null, "unlisted 'data-unlisted' attribute must be stripped");
  assert.strictEqual(kbd.getAttribute("data-mapped"), "true", "must map to htmlElements.kbd");
  root.unmount();
}
async function testNestedSyntaxRuleWithCaptureAndCursorOffset(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "missing render root");

  const syntax: SyntaxRuleSpec[] = [
    {
      name: "containerBox",
      pattern: { source: "\\[\\[([\\s\\S]*?)\\]\\]" },
      content: 1,
    },
    {
      name: "ticket",
      pattern: { source: "#([A-Z]+-\\d+)" },
      attrs: { id: 1 },
    },
  ];

  const ContainerComp = ({ children }: { children?: React.ReactNode }) => (
    <span className="custom-container">{children}</span>
  );

  const TicketComp = ({ attrs }: { attrs?: Record<string, string | number> }) => (
    <span className="custom-ticket" data-ticket-id={String(attrs?.id ?? "")}>
      {String(attrs?.id ?? "")}
    </span>
  );

  const root = createRoot(container!);
  root.render(
    <StreamingMarkdown
      engine="main-thread"
      text="Check [[contained issue #XYZ-99]] here."
      syntax={syntax}
      inlineComponents={{
        containerBox: ContainerComp,
        ticket: TicketComp,
      }}
    />,
  );

  await waitForMutation(container!, () => {
    return Boolean(container!.querySelector(".custom-container .custom-ticket"));
  });

  const containerEl = container!.querySelector(".custom-container");
  assert.ok(containerEl, "custom-container must exist");
  const ticketEl = containerEl.querySelector(".custom-ticket");
  assert.ok(ticketEl, "ticket must be nested inside custom-container");
  assert.strictEqual(ticketEl.getAttribute("data-ticket-id"), "XYZ-99");
  // Verify outer delimiters [[ and ]] are not in the container text
  assert.ok(!containerEl.textContent?.includes("[["), "outer [[ must not be part of container text");
  assert.ok(!containerEl.textContent?.includes("]]"), "outer ]] must not be part of container text");
  root.unmount();
}

async function testHeadingRendersPluginNodes(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "missing render root");

  const syntax: SyntaxRuleSpec[] = [
    {
      name: "ticket",
      pattern: { source: "#([A-Z]+-\\d+)" },
      attrs: { id: 1 },
    },
  ];

  const TicketComp = ({ attrs }: { attrs?: Record<string, string | number> }) => (
    <span className="custom-ticket" data-ticket-id={String(attrs?.id ?? "")}>
      {String(attrs?.id ?? "")}
    </span>
  );

  const root = createRoot(container!);
  root.render(
    <StreamingMarkdown
      engine="main-thread"
      text="# Issue #ABC-123 Tracker"
      syntax={syntax}
      inlineComponents={{
        ticket: TicketComp,
      }}
    />,
  );

  await waitForMutation(container!, () => {
    return Boolean(container!.querySelector("h1 .custom-ticket"));
  });

  const ticketInHeading = container!.querySelector("h1 .custom-ticket");
  assert.ok(ticketInHeading, "custom-ticket must render inside h1 heading");
  assert.strictEqual(ticketInHeading.getAttribute("data-ticket-id"), "ABC-123");
  root.unmount();
}

async function testHtmlChildrenPreservedInMapping(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "missing render root");

  const root = createRoot(container!);
  root.render(
    <StreamingMarkdown
      engine="main-thread"
      text='<span class="wrapper">Hello <strong>world</strong></span>'
      html={{
        allowedTags: {
          span: ["class"],
          strong: [],
        },
      }}
      htmlElements={{
        span: ({ className, children, ...props }: React.HTMLAttributes<HTMLElement>) => (
          <span className={`custom-span ${className ?? ""}`.trim()} {...props}>
            {children}
          </span>
        ),
      }}
    />,
  );

  await waitForMutation(container!, () => {
    return Boolean(container!.querySelector(".custom-span strong"));
  });

  const strongInsideSpan = container!.querySelector(".custom-span strong");
  assert.ok(strongInsideSpan, "nested <strong> must be preserved inside custom span");
  assert.strictEqual(strongInsideSpan.textContent, "world");
  root.unmount();
}

async function testLiteralTagContent(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "missing render root");

  const root = createRoot(container!);
  root.render(
    <StreamingMarkdown
      engine="main-thread"
      text="Compare <kbd>**not bold**</kbd> and <span>**bold**</span>"
      html={{
        allowedTags: {
          kbd: [],
          span: [],
        },
        literalTagContent: ["kbd"],
      }}
    />,
  );

  await waitForMutation(container!, () => {
    return Boolean(container!.querySelector("kbd") && container!.querySelector("span strong"));
  });

  const kbdEl = container!.querySelector("kbd");
  assert.ok(kbdEl, "kbd must be rendered");
  assert.strictEqual(kbdEl.textContent, "**not bold**", "literal tag content must preserve raw markdown syntax as text");
  assert.strictEqual(kbdEl.querySelector("strong"), null, "kbd must not contain strong elements");

  const spanStrong = container!.querySelector("span strong");
  assert.ok(spanStrong, "span (non-literal tag) must parse inner markdown to strong");
  assert.strictEqual(spanStrong.textContent, "bold");
  root.unmount();
}

async function testBlockHtmlAllowedTagsAndAttributes(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "missing render root");

  const root = createRoot(container!);
  root.render(
    <StreamingMarkdown
      engine="main-thread"
      text={'<div><kbd hotkey="ctrl+c" bad="forbidden">Copy</kbd></div>'}
      html={{
        allowedTags: {
          div: [],
          kbd: ["hotkey"],
        },
      }}
      htmlElements={{
        kbd: (props: React.HTMLAttributes<HTMLElement>) => (
          <kbd className="mapped-block-kbd" {...props}>
            {props.children}
          </kbd>
        ),
      }}
    />,
  );

  await waitForMutation(container!, () => {
    return Boolean(container!.querySelector(".mapped-block-kbd"));
  });

  const kbd = container!.querySelector(".mapped-block-kbd");
  assert.ok(kbd, "mapped block kbd must be rendered");
  assert.strictEqual(kbd.getAttribute("hotkey"), "ctrl+c", "allowed attribute must be preserved");
  assert.strictEqual(kbd.getAttribute("bad"), null, "unlisted attribute must be stripped");
  root.unmount();
}

async function testAnticipationOverlapAndStreamingStatus(): Promise<void> {
  const patches: Array<{ blockId: string; meta?: Record<string, unknown> }> = [];
  const engine = new MarkdownEngine({
    post: (msg) => {
      if (msg.type === "PATCH") {
        for (const p of msg.patches) {
          const block = (p as { node?: { props?: { block?: { id: string; payload?: { meta?: Record<string, unknown> } } } } }).node?.props?.block;
          if (block) {
            patches.push({ blockId: block.id, meta: block.payload?.meta });
          }
        }
      }
    },
  });

  await engine.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, syntax: [
    {
      name: "wiki",
      pattern: { source: "\\[\\[([^\\]]+)\\]\\]" },
      anticipation: { open: "[[", close: "]]" },
    },
  ], });

  // Stream unclosed anticipation open
  await engine.handle({
    type: "APPEND",
    text: "Here is [[partially",
  });

  // Verify anticipation was triggered
  const lastPatch = patches[patches.length - 1];
  assert.ok(lastPatch, "expected at least one block patch during streaming");
  assert.strictEqual(lastPatch.meta?.inlineStatus, "anticipated", "streaming unclosed syntax rule must mark inlineStatus as anticipated");

  // Append closing delimiter
  await engine.handle({
    type: "APPEND",
    text: " closed]] link",
  });
  await engine.handle({
    type: "FINALIZE",
  });

  const finalPatch = patches[patches.length - 1];
  assert.ok(finalPatch, "expected patch on finalize");
  assert.strictEqual(finalPatch.meta?.inlineStatus, undefined, "finalized block must have deleted temporary anticipated inlineStatus");
}

async function testDynamicPropUpdatesReInits(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "missing render root");

  const root = createRoot(container!);
  // Initially without syntax rule
  root.render(
    <StreamingMarkdown
      engine="main-thread"
      text="Ticket #DEF-456 active"
    />,
  );

  await waitForMutation(container!, () => {
    return container!.textContent?.includes("#DEF-456") ?? false;
  });
  assert.strictEqual(container!.querySelector(".dynamic-ticket"), null, "should not have ticket component initially");

  // Update with syntax rules
  const syntax: SyntaxRuleSpec[] = [
    {
      name: "ticket",
      pattern: { source: "#([A-Z]+-\\d+)" },
      attrs: { id: 1 },
    },
  ];

  root.render(
    <StreamingMarkdown
      engine="main-thread"
      text="Ticket #DEF-456 active"
      syntax={syntax}
      inlineComponents={{
        ticket: ({ attrs }: { attrs?: Record<string, string | number> }) => (
          <span className="dynamic-ticket" data-id={String(attrs?.id ?? "")}>
            {String(attrs?.id ?? "")}
          </span>
        ),
      }}
    />,
  );

  await waitForMutation(container!, () => {
    return Boolean(container!.querySelector(".dynamic-ticket"));
  });

  const dynamicTicket = container!.querySelector(".dynamic-ticket");
  assert.ok(dynamicTicket, "dynamic ticket component must be rendered after prop update");
  assert.strictEqual(dynamicTicket.getAttribute("data-id"), "DEF-456");
  root.unmount();
}

async function testInvalidRegexRecoveryWithValidRule(): Promise<void> {
  const errors: unknown[] = [];
  const engine = new MarkdownEngine({
    post: (msg) => {
      if (msg.type === "ERROR") {
        errors.push(msg);
      }
    },
  });

  await engine.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, syntax: [
    {
      name: "badRule",
      pattern: { source: "[invalid(regex" },
    },
    {
      name: "ticket",
      pattern: { source: "#([A-Z]+-\\d+)" },
      attrs: { id: 1 },
    },
  ], });

  assert.ok(errors.length > 0, "should report error for badRule");

  // Test that ticket rule is still registered and active
  const parsed = engine.inlineParser.parse("Resolves #FIX-888 now");
  const pluginNode = parsed.find((n) => n.kind === "plugin" && n.name === "ticket");
  assert.ok(pluginNode, "valid rule must still be active and parse nodes despite prior invalid rule");
  assert.strictEqual(pluginNode.attrs?.id, "FIX-888");
}

console.log("1: testInvalidRegexYieldsErrorMessage");
await testInvalidRegexYieldsErrorMessage();
console.log("2: testInvalidRegexRecoveryWithValidRule");
await testInvalidRegexRecoveryWithValidRule();
console.log("3: testSyntaxRuleStaticAndStreamedIdentical");
await testSyntaxRuleStaticAndStreamedIdentical();
console.log("4: testSyntaxRuleNestedInBold");
await testSyntaxRuleNestedInBold();
console.log("5: testNestedSyntaxRuleWithCaptureAndCursorOffset");
await testNestedSyntaxRuleWithCaptureAndCursorOffset();
console.log("6: testHeadingRendersPluginNodes");
await testHeadingRendersPluginNodes();
console.log("7: testAllowedTagsAndHtmlElements");
await testAllowedTagsAndHtmlElements();
console.log("8: testHtmlChildrenPreservedInMapping");
await testHtmlChildrenPreservedInMapping();
console.log("9: testLiteralTagContent");
await testLiteralTagContent();
console.log("10: testBlockHtmlAllowedTagsAndAttributes");
await testBlockHtmlAllowedTagsAndAttributes();
console.log("11: testAnticipationOverlapAndStreamingStatus");
await testAnticipationOverlapAndStreamingStatus();
console.log("12: testDynamicPropUpdatesReInits");
await testDynamicPropUpdatesReInits();
console.log("All syntax rules and HTML allowlist acceptance tests passed successfully.");

