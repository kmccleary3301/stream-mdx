import assert from "node:assert";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HtmlTreeNode } from "@stream-mdx/core";
import { renderHtmlOwnershipTree } from "../src/utils/inline-html";
import { defineContentComponent, normalizeContentComponents, type ContentComponentProps } from "../src/components/content-components";
import { ComponentRegistry } from "../src/components";

// Test suite for restricted component dispatch & runtime evaluation traps

function CalloutComponent(props: { title?: string; type?: string; children?: React.ReactNode; "data-diagnostic"?: string; "data-component-status"?: string }) {
  return (
    <div
      className={`callout callout-${props.type ?? "info"}`}
      data-title={props.title}
      data-diagnostic={props["data-diagnostic"]}
      data-component-status={props["data-component-status"]}
    >
      <h3>{props.title}</h3>
      <div className="callout-body">{props.children}</div>
    </div>
  );
}

function InputComponent(props: { placeholder?: string; disabled?: boolean }) {
  return <input className="custom-input" placeholder={props.placeholder} disabled={props.disabled} />;
}

async function runTests() {
  const isCalloutProps = (
    props: ContentComponentProps,
  ): props is ContentComponentProps & React.ComponentProps<typeof CalloutComponent> =>
    typeof props.title === "string" && (!props.type || typeof props.type === "string");
  const isInputProps = (
    props: ContentComponentProps,
  ): props is ContentComponentProps & React.ComponentProps<typeof InputComponent> =>
    (props.placeholder === undefined || typeof props.placeholder === "string") &&
    (props.disabled === undefined || typeof props.disabled === "boolean");
  const registrations = normalizeContentComponents({
    Callout: defineContentComponent({
      component: CalloutComponent,
      validateProps: isCalloutProps,
      renderWhen: "open",
    }),
    ClosedOnly: defineContentComponent({
      component: CalloutComponent,
      validateProps: isCalloutProps,
      renderWhen: "closed",
    }),
    Input: defineContentComponent({
      component: InputComponent,
      validateProps: isInputProps,
    }),
  });

  const registry = new ComponentRegistry({}, {}, {}, {
    contentComponents: registrations,
  });

  // Test 1: Literal case-preserving dispatch with frozen props and native children
  {
    const tree: HtmlTreeNode[] = [
      {
        kind: "component",
        name: "Callout",
        props: Object.freeze({ title: "Important Note", type: "warning" }),
        status: "closed",
        children: [
          {
            kind: "element",
            tagName: "p",
            attributes: {},
            children: [{ kind: "text", text: "This is a native paragraph inside Callout." }],
          },
        ],
      },
    ];

    const rendered = renderHtmlOwnershipTree(
      tree,
      registry.getHtmlElements(),
      (block) => registry.renderBlock(block),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      registrations,
    );

    const html = renderToStaticMarkup(<>{rendered}</>);
    assert.ok(html.includes('class="callout callout-warning"'), "must dispatch to CalloutComponent with correct class");
    assert.ok(html.includes('data-title="Important Note"'), "must pass frozen props");
    assert.ok(html.includes("This is a native paragraph inside Callout."), "must render native prepared children");
  }

  // Test 2: Host validateProps callback rejection falls back to raw source
  {
    const rawTag = '<Callout title={12345} type="invalid">';
    const tree: HtmlTreeNode[] = [
      {
        kind: "component",
        name: "Callout",
        props: Object.freeze({ title: 12345 as unknown as string }), // Fails validateProps (expects string)
        status: "closed",
        children: [],
        rawSource: rawTag,
      },
    ];

    const rendered = renderHtmlOwnershipTree(
      tree,
      registry.getHtmlElements(),
      (block) => registry.renderBlock(block),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      registrations,
    );

    const html = renderToStaticMarkup(<>{rendered}</>);
    assert.ok(!html.includes('class="callout'), "invalid props must not render component");
    assert.ok(html.includes("&lt;Callout title={12345}"), "must preserve escaped raw source on validation failure");
  }

  // Test 3: renderWhen="closed" optout suppresses open tag during streaming
  {
    const treeOpen: HtmlTreeNode[] = [
      {
        kind: "component",
        name: "ClosedOnly",
        props: Object.freeze({ title: "In-flight" }),
        status: "open",
        children: [{ kind: "text", text: "Streaming content..." }],
      },
    ];

    const renderedOpen = renderHtmlOwnershipTree(
      treeOpen,
      registry.getHtmlElements(),
      (block) => registry.renderBlock(block),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      registrations,
    );

    const htmlOpen = renderToStaticMarkup(<>{renderedOpen}</>);
    assert.strictEqual(htmlOpen, "", "renderWhen: 'closed' must not render while status is 'open'");

    // When closed, it renders
    const treeClosed: HtmlTreeNode[] = [
      {
        kind: "component",
        name: "ClosedOnly",
        props: Object.freeze({ title: "Completed" }),
        status: "closed",
        children: [{ kind: "text", text: "Final content." }],
      },
    ];

    const renderedClosed = renderHtmlOwnershipTree(
      treeClosed,
      registry.getHtmlElements(),
      (block) => registry.renderBlock(block),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      registrations,
    );

    const htmlClosed = renderToStaticMarkup(<>{renderedClosed}</>);
    assert.ok(htmlClosed.includes('data-title="Completed"'), "must render when status is closed");
  }

  // Test 4: unclosed FINALIZE retains render + diagnostic even with renderWhen="closed"
  {
    const treeIncomplete: HtmlTreeNode[] = [
      {
        kind: "component",
        name: "ClosedOnly",
        props: Object.freeze({ title: "Unclosed Stream" }),
        status: "incomplete",
        children: [{ kind: "text", text: "Children survive unclosed finalize." }],
        diagnostic: "Unclosed component tag at end of document",
      },
    ];

    const rendered = renderHtmlOwnershipTree(
      treeIncomplete,
      registry.getHtmlElements(),
      (block) => registry.renderBlock(block),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      registrations,
    );

    const html = renderToStaticMarkup(<>{rendered}</>);
    assert.ok(html.includes('data-title="Unclosed Stream"'), "unclosed FINALIZE must retain render");
    assert.ok(html.includes('data-component-status="incomplete"'), "must attach component status");
    assert.ok(html.includes('data-diagnostic="Unclosed component tag at end of document"'), "must attach diagnostic");
    assert.ok(html.includes("Children survive unclosed finalize."), "children must be rendered");
  }

  // Test 5: Unknown component tag falls back to escaped raw source
  {
    const rawUnknown = "<UnknownWidget variant='danger' />";
    const tree: HtmlTreeNode[] = [
      {
        kind: "text",
        text: rawUnknown,
        rawSource: rawUnknown,
        diagnostic: "Unknown component <UnknownWidget>",
      },
    ];

    const rendered = renderHtmlOwnershipTree(
      tree,
      registry.getHtmlElements(),
      (block) => registry.renderBlock(block),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      registrations,
    );

    const html = renderToStaticMarkup(<>{rendered}</>);
    assert.ok(html.includes("&lt;UnknownWidget variant=&#x27;danger&#x27; /&gt;"), "unknown component must preserve escaped raw source");
  }

  // Test 6: Runtime evaluation trap - no eval or execution bypass
  {
    let evaluationAttempted = false;
    (globalThis as Record<string, unknown>).__TRAP_INVOKED__ = () => {
      evaluationAttempted = true;
    };

    const maliciousTree: HtmlTreeNode[] = [
      {
        kind: "component",
        name: "Callout",
        props: Object.freeze({
          title: "Safe Title",
          type: "info",
          // Object with malicious getter or function must never be executed
          malicious: () => { evaluationAttempted = true; },
        }),
        status: "closed",
        children: [{ kind: "text", text: "Harmless text" }],
      },
    ];

    const rendered = renderHtmlOwnershipTree(
      maliciousTree,
      registry.getHtmlElements(),
      (block) => registry.renderBlock(block),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      registrations,
    );

    renderToStaticMarkup(<>{rendered}</>);
    assert.strictEqual(evaluationAttempted, false, "restricted dispatch must never invoke arbitrary closures or eval");
    delete (globalThis as Record<string, unknown>).__TRAP_INVOKED__;
  }
}

await runTests();
