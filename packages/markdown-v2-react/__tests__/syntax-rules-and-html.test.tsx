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
  (globalThis as unknown as Record<string, unknown>).requestAnimationFrame = window.requestAnimationFrame.bind(window);
  (globalThis as unknown as Record<string, unknown>).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  return window as unknown as Window & typeof globalThis;
}

function waitForMutation(container: HTMLElement, predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const defaultView = container.ownerDocument.defaultView;
  const ObserverClass = defaultView?.MutationObserver ?? MutationObserver;
  let timer: NodeJS.Timeout | undefined;
  const check = () => {
    if (predicate()) {
      clearInterval(timer);
      observer.disconnect();
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

  await engine.handle({
    type: "INIT",
    syntax: [
      {
        name: "invalidRule",
        pattern: { source: "[unclosed-bracket(" },
      },
    ],
  });

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
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 2);
      await promise;
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

await testInvalidRegexYieldsErrorMessage();
await testSyntaxRuleStaticAndStreamedIdentical();
await testSyntaxRuleNestedInBold();
await testAllowedTagsAndHtmlElements();
console.log("All syntax rules and HTML allowlist acceptance tests passed successfully.");
