import assert from "node:assert";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import type { HtmlTreeNode, WorkerIn, WorkerOut } from "@stream-mdx/core";
import { MarkdownBlocksRenderer } from "@stream-mdx/react/server";
import { ComponentRegistry } from "@stream-mdx/react";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { defineContentComponent, type ContentComponentProps } from "../../markdown-v2-react/src/components/content-components";
import { createWorkerHarness } from "./worker-test-harness";
import { buildRestrictedComponentTree } from "../src/engine/restricted-component-ownership";

function findMessage<T extends WorkerOut["type"]>(
  messages: WorkerOut[],
  type: T,
): Extract<WorkerOut, { type: T }> | undefined {
  return messages.find((m): m is Extract<WorkerOut, { type: T }> => m.type === type);
}

describe("Worker Restricted Component Ownership & Native HtmlTree", () => {
  const registeredComponents = [
    { name: "Card", renderWhen: "open" as const },
    { name: "Input", renderWhen: "open" as const },
    { name: "Alert", renderWhen: "closed" as const },
    { name: "Link", renderWhen: "open" as const },
  ];

  it("produces kind:component HtmlTreeNode with case-sensitive name and frozen JSON props", async () => {
    const harness = await createWorkerHarness();
    const init: WorkerIn = {
      type: "INIT",
      initialContent: '<Input placeholder="Search docs..." disabled count={5} />',
      contentPolicy: "restricted",
      contentComponents: registeredComponents,
    };

    const messages = await harness.send(init);
    const initialized = findMessage(messages, "INITIALIZED");
    assert.ok(initialized, "worker must initialize");

    const blocks = initialized.blocks;
    assert.strictEqual(blocks.length, 1);
    const block = blocks[0];
    const tree = block.payload.meta?.htmlTree as HtmlTreeNode[] | undefined;
    assert.ok(tree && tree.length > 0, "must produce htmlTree");

    const root = tree[0];
    assert.strictEqual(root.kind, "component", "must produce kind: component node");
    if (root.kind === "component") {
      assert.strictEqual(root.name, "Input", "must preserve exact case");
      assert.strictEqual(root.status, "closed", "self-closing tag must have status: closed");
      assert.strictEqual(root.props.placeholder, "Search docs...");
      assert.strictEqual(root.props.disabled, true);
      assert.strictEqual(root.props.count, 5);
      assert.strictEqual(Object.isFrozen(root.props), true, "props must be frozen");
      assert.strictEqual(root.children.length, 0);
    }
  });

  it("preserves case: Input/Link components vs HTML void tags input/link", async () => {
    const harness = await createWorkerHarness();
    const init: WorkerIn = {
      type: "INIT",
      initialContent: '<input type="text">\n\n<Input placeholder="component" />',
      contentPolicy: "restricted",
      contentComponents: registeredComponents,
    };

    const messages = await harness.send(init);
    const initialized = findMessage(messages, "INITIALIZED");
    assert.ok(initialized);

    const blocks = initialized.blocks;
    assert.strictEqual(blocks.length, 2);

    // Block 0: HTML void element <input>
    const htmlTree0 = blocks[0].payload.meta?.htmlTree as HtmlTreeNode[] | undefined;
    assert.ok(htmlTree0 && htmlTree0.length > 0);
    assert.strictEqual(htmlTree0[0].kind, "element", "lowercase input must stay element");
    if (htmlTree0[0].kind === "element") {
      assert.strictEqual(htmlTree0[0].tagName, "input");
    }

    // Block 1: Component <Input>
    const htmlTree1 = blocks[1].payload.meta?.htmlTree as HtmlTreeNode[] | undefined;
    assert.ok(htmlTree1 && htmlTree1.length > 0);
    assert.strictEqual(htmlTree1[0].kind, "component", "uppercase Input must be component");
    if (htmlTree1[0].kind === "component") {
      assert.strictEqual(htmlTree1[0].name, "Input");
    }
  });

  it("handles multi-block region ownership, preserving native Markdown body, code, and list identity", async () => {
    const harness = await createWorkerHarness();
    const content = [
      '<Card title="Container">',
      "",
      "A native markdown paragraph with **bold** text.",
      "",
      "- list item 1",
      "- list item 2",
      "",
      "```js",
      "const answer = 42;",
      "```",
      "",
      "</Card>",
    ].join("\n");

    const init: WorkerIn = {
      type: "INIT",
      initialContent: content,
      contentPolicy: "restricted",
      contentComponents: registeredComponents,
    };

    const messages = await harness.send(init);
    const initialized = findMessage(messages, "INITIALIZED");
    assert.ok(initialized);

    const blocks = initialized.blocks;
    assert.strictEqual(blocks.length, 1, "region must be grouped into one owner root");

    const tree = blocks[0].payload.meta?.htmlTree as HtmlTreeNode[] | undefined;
    assert.ok(tree && tree.length > 0);
    const componentNode = tree[0];
    assert.strictEqual(componentNode.kind, "component");
    if (componentNode.kind === "component") {
      assert.strictEqual(componentNode.name, "Card");
      assert.strictEqual(componentNode.status, "closed");
      assert.strictEqual(componentNode.props.title, "Container");

      // Verify native children
      const children = componentNode.children;
      assert.strictEqual(children.length, 3, "must embed 3 native markdown child blocks");

      // Child 0: paragraph block leaf
      assert.strictEqual(children[0].kind, "block");
      if (children[0].kind === "block") {
        assert.strictEqual(children[0].block.type, "paragraph");
        assert.match(children[0].block.payload.raw, /native markdown paragraph/);
      }

      // Child 1: list block leaf
      assert.strictEqual(children[1].kind, "block");
      if (children[1].kind === "block") {
        assert.strictEqual(children[1].block.type, "list");
      }

      // Child 2: code block leaf
      assert.strictEqual(children[2].kind, "block");
      if (children[2].kind === "block") {
        assert.strictEqual(children[2].block.type, "code");
        assert.match(children[2].block.payload.raw, /const answer = 42/);
      }
    }
  });

  it("supports validated opening early render during streaming with frozen props", async () => {
    const harness = await createWorkerHarness();
    const init: WorkerIn = {
      type: "INIT",
      initialContent: '<Card title="Early Stream">',
      contentPolicy: "restricted",
      contentComponents: registeredComponents,
    };

    const initMessages = await harness.send(init);
    const initialized = findMessage(initMessages, "INITIALIZED");
    assert.ok(initialized);

    const openBlock = initialized.blocks[0];
    assert.strictEqual(openBlock.isFinalized, false, "unclosed component must not be finalized during streaming");

    const tree = openBlock.payload.meta?.htmlTree as HtmlTreeNode[] | undefined;
    assert.ok(tree && tree.length > 0);
    const node = tree[0];
    assert.strictEqual(node.kind, "component");
    if (node.kind === "component") {
      assert.strictEqual(node.name, "Card");
      assert.strictEqual(node.status, "open", "must render early with status: open");
      assert.strictEqual(node.props.title, "Early Stream");
      assert.strictEqual(Object.isFrozen(node.props), true);
    }
  });

  it("retains unclosed incomplete component on FINALIZE with diagnostic", async () => {
    const harness = await createWorkerHarness();
    const init: WorkerIn = {
      type: "INIT",
      initialContent: '<Card title="Unfinished">\n\nBody paragraph.',
      contentPolicy: "restricted",
      contentComponents: registeredComponents,
    };

    await harness.send(init);
    const finalizeMessages = await harness.send({ type: "FINALIZE" });
    const finalizedMsg = findMessage(finalizeMessages, "FINALIZED");
    assert.ok(finalizedMsg, "worker must emit FINALIZED");

    // Verify restricted component tree retains incomplete status and children when finalized unclosed
    const directTree = buildRestrictedComponentTree(
      '<Card title="Unfinished">\n\nBody paragraph.',
      new Map(registeredComponents.map((c) => [c.name, c])),
      { forceFinalize: true, childrenBlocks: [{ id: "b1", type: "paragraph", isFinalized: true, payload: { raw: "Body paragraph." } }] },
    );
    assert.ok(directTree && directTree.length > 0);
    const node = directTree[0];
    assert.strictEqual(node.kind, "component");
    if (node.kind === "component") {
      assert.strictEqual(node.status, "incomplete");
      assert.ok(node.diagnostic, "must have incomplete diagnostic");
      assert.strictEqual(node.children.length, 1, "must retain children");
    }
  });

  it("falls back to text with diagnostic for unknown or invalid component tags", async () => {
    const harness = await createWorkerHarness();
    const init: WorkerIn = {
      type: "INIT",
      initialContent: '<UnknownWidget prop="val" />\n\n<Card 12345>',
      contentPolicy: "restricted",
      contentComponents: registeredComponents,
    };

    const messages = await harness.send(init);
    const initialized = findMessage(messages, "INITIALIZED");
    assert.ok(initialized);

    const blocks = initialized.blocks;
    assert.strictEqual(blocks.length, 2);

    // Unknown component
    const tree0 = blocks[0].payload.meta?.htmlTree as HtmlTreeNode[] | undefined;
    assert.ok(tree0 && tree0.length > 0);
    assert.strictEqual(tree0[0].kind, "text");
    if (tree0[0].kind === "text") {
      assert.match(tree0[0].text, /<UnknownWidget/);
      assert.match(tree0[0].diagnostic ?? "", /Unknown component/);
    }

    // Invalid component header
    const tree1 = blocks[1].payload.meta?.htmlTree as HtmlTreeNode[] | undefined;
    assert.ok(tree1 && tree1.length > 0);
    assert.strictEqual(tree1[0].kind, "text");
    if (tree1[0].kind === "text") {
      assert.match(tree1[0].text, /<Card 12345>/);
      assert.match(tree1[0].diagnostic ?? "", /Invalid component tag/);
    }
  });

  it("disables automatic MDX detection under contentPolicy: restricted", async () => {
    const harness = await createWorkerHarness();
    const init: WorkerIn = {
      type: "INIT",
      initialContent: '<Card title="Restricted" />\n\n{1 + 2}\n\nimport { x } from "mod";',
      contentPolicy: "restricted",
      contentComponents: registeredComponents,
    };

    const messages = await harness.send(init);
    const initialized = findMessage(messages, "INITIALIZED");
    assert.ok(initialized);

    // None of the blocks should have type: "mdx"
    for (const block of initialized.blocks) {
      assert.notStrictEqual(block.type, "mdx", "no block should be converted to mdx under restricted policy");
    }
  });
  it("keeps an incomplete registered opening header literal and non-executable", async () => {
    const harness = await createWorkerHarness();
    const messages = await harness.send({
      type: "INIT",
      initialContent: '<Card title="unfinished',
      contentPolicy: "restricted",
      contentComponents: registeredComponents,
    });
    const initialized = findMessage(messages, "INITIALIZED");
    assert.ok(initialized);

    const tree = initialized.blocks[0].payload.meta?.htmlTree as HtmlTreeNode[] | undefined;
    assert.ok(tree && tree.length > 0);
    assert.strictEqual(tree[0].kind, "text");
    if (tree[0].kind === "text") {
      assert.strictEqual(tree[0].text, '<Card title="unfinished');
      assert.match(tree[0].diagnostic ?? "", /Invalid component tag/);
    }
  });

  it("keeps a following native block outside a self-closing registered component", async () => {
    const harness = await createWorkerHarness();
    const messages = await harness.send({
      type: "INIT",
      initialContent: '<Input placeholder="search" />\n\nFollowing paragraph stays native.',
      contentPolicy: "restricted",
      contentComponents: registeredComponents,
    });
    const initialized = findMessage(messages, "INITIALIZED");
    assert.ok(initialized);
    assert.strictEqual(initialized.blocks.length, 2);

    const componentTree = initialized.blocks[0].payload.meta?.htmlTree as HtmlTreeNode[] | undefined;
    assert.ok(componentTree && componentTree.length > 0);
    assert.strictEqual(componentTree[0].kind, "component");
    if (componentTree[0].kind === "component") {
      assert.strictEqual(componentTree[0].name, "Input");
      assert.strictEqual(componentTree[0].status, "closed");
    }
    assert.strictEqual(initialized.blocks[1].type, "paragraph");
    assert.strictEqual(initialized.blocks[1].payload.raw, "Following paragraph stays native.");
  });

  it("retains native first/last body fragments and following text around a registered container", async () => {
    const harness = await createWorkerHarness();
    const messages = await harness.send({
      type: "INIT",
      initialContent: [
        '<Card title="edge">opening fragment',
        "",
        "Native body paragraph.",
        "",
        "closing fragment</Card> suffix",
      ].join("\n"),
      contentPolicy: "restricted",
      contentComponents: registeredComponents,
    });
    const initialized = findMessage(messages, "INITIALIZED");
    assert.ok(initialized);
    assert.strictEqual(initialized.blocks.length, 1);

    const tree = initialized.blocks[0].payload.meta?.htmlTree as HtmlTreeNode[] | undefined;
    assert.ok(tree && tree.length > 0);
    const root = tree[0];
    assert.strictEqual(root.kind, "component");
    if (root.kind === "component") {
      assert.strictEqual(root.status, "closed");
      assert.ok(root.children.some((child) => child.kind === "text" && child.text.includes("opening fragment")));
      assert.ok(root.children.some((child) => child.kind === "text" && child.text.includes("closing fragment")));
      assert.ok(root.children.some((child) => child.kind === "block" && child.block.payload.raw === "Native body paragraph."));
    }
    assert.ok(tree.slice(1).some((node) => node.kind === "text" && node.text.includes("suffix")));
  });

  it("ignores closing-looking code and nested registered closes when balancing an outer container", async () => {
    const harness = await createWorkerHarness();
    const messages = await harness.send({
      type: "INIT",
      initialContent: [
        '<Card title="outer">',
        "",
        "```txt",
        "</Card>",
        "```",
        "",
        '<Card title="inner">',
        "",
        "Nested body.",
        "",
        "</Card>",
        "",
        "Outer body.",
        "",
        "</Card>",
      ].join("\n"),
      contentPolicy: "restricted",
      contentComponents: registeredComponents,
    });
    const initialized = findMessage(messages, "INITIALIZED");
    assert.ok(initialized);
    assert.strictEqual(initialized.blocks.length, 1);

    const tree = initialized.blocks[0].payload.meta?.htmlTree as HtmlTreeNode[] | undefined;
    assert.ok(tree && tree.length > 0);
    const root = tree[0];
    assert.strictEqual(root.kind, "component");
    if (root.kind === "component") {
      assert.strictEqual(root.name, "Card");
      assert.strictEqual(root.status, "closed");
      assert.ok(root.children.some((child) => child.kind === "block" && child.block.type === "code" && child.block.payload.raw.includes("</Card>")));
    }
  });

  it("renders restricted tags recursively through native phrasing, quote, list, HTML, and protected siblings", async () => {
    type TitleProps = ContentComponentProps & { title?: string };
    type InputProps = ContentComponentProps & { placeholder?: string };
    const isTitleProps = (props: ContentComponentProps): props is TitleProps =>
      props.title === undefined || typeof props.title === "string";
    const isInputProps = (props: ContentComponentProps): props is InputProps =>
      props.placeholder === undefined || typeof props.placeholder === "string";
    const Card = (props: { title?: string; children?: React.ReactNode }) =>
      React.createElement("section", { "data-card": props.title }, props.children);
    const Alert = (props: { title?: string; children?: React.ReactNode }) =>
      React.createElement("span", { "data-alert": props.title }, props.children);
    const Input = (props: { placeholder?: string }) =>
      React.createElement("input", { "data-input": props.placeholder });
    const hostComponents = {
      Card: defineContentComponent({ component: Card, validateProps: isTitleProps, renderWhen: "open" }),
      Alert: defineContentComponent({ component: Alert, validateProps: isTitleProps, renderWhen: "closed" }),
      Input: defineContentComponent({ component: Input, validateProps: isInputProps, renderWhen: "open" }),
    };
    const Strong = ({ children }: { children?: React.ReactNode }) =>
      React.createElement("strong", { "data-inline-owner": "configured" }, children);
    const componentRegistry = new ComponentRegistry({}, { strong: Strong });
    const content = [
      '<Card title="root">',
      "",
      'Native **bold** with <Alert title="paired">nested <Input placeholder="nested" /></Alert> and <Input placeholder="self" />.',
      "",
      '**Formatted <Input placeholder="emphasis" /> suffix** and [before <Alert title="link">linked</Alert>](/safe).',
      "",
      'Encoded &#xE000;smdx-restricted-inline-0&#xE001; <Input placeholder="encoded-real" />.',
      "",
      `[protected title](/safe '<Input placeholder="title-protected" />') and ![<Input placeholder="image-protected" />](/image.png).`,
      "",
      `<span title='<Input placeholder="attribute-protected" />'>native attribute</span>`,
      "",
      '## Heading with <Alert title="heading">title</Alert>',
      "",
      '> Quote with <Alert title="quote">quoted</Alert>.',
      '<div>HTML <Alert title="html">leaf</Alert></div>',
      "",
      "",
      '- List with <Input placeholder="list" />.',
      "",
      '- **before <Input placeholder="list-emphasis" /> after**',
      '- <Alert title="list-owned">**before <Input placeholder="list-owned-child" /> after**</Alert>',
      "",
      '`<Input placeholder="code" />`',
      "",
      '<Alert title={globalThis.__restrictedAdmissionSentinel()} />',
      "",
      "</Card>",
      "",
      '<Card title="mismatch"><Alert title="unclosed">mismatch</Card>',
    ].join("\n");
    let sentinelCalls = 0;
    const globalWithSentinel = globalThis as typeof globalThis & { __restrictedAdmissionSentinel?: () => string };
    globalWithSentinel.__restrictedAdmissionSentinel = () => {
      sentinelCalls++;
      return "executed";
    };
    let dom: JSDOM | undefined;
    try {
      const harness = await createWorkerHarness();
      const messages = await harness.send({
        type: "INIT",
        initialContent: content,
        contentPolicy: "restricted",
        contentComponents: registeredComponents,
      });
      const initialized = findMessage(messages, "INITIALIZED");
      assert.ok(initialized);
      const rendered = renderToStaticMarkup(
        React.createElement(MarkdownBlocksRenderer, { blocks: initialized.blocks, contentComponents: hostComponents, componentRegistry }),
      );

      dom = new JSDOM(rendered);
      const document = dom.window.document;
      assert.ok(document.querySelector('section[data-card="root"]'), "outer host component must render");
      assert.strictEqual(document.querySelector("p strong")?.textContent, "bold", "native paragraph formatting must remain");
      assert.ok(document.querySelector('[data-alert="paired"] [data-input="nested"]'), "paired component must own its nested self-closing host");
      assert.ok(document.querySelector('[data-input="self"]'), "self-closing component in native phrasing must render");
      assert.ok(document.querySelector('strong [data-input="emphasis"]'), "native emphasis must span the admitted component");
      assert.strictEqual(document.querySelector('a[href="/safe"] [data-alert="link"]')?.textContent, "linked", "native link must span the admitted component");
      assert.ok(document.querySelector('[data-input="encoded-real"]'), "entity-encoded authored text must not forge an admission marker");
      assert.ok(document.body.textContent?.includes("\uE000smdx-restricted-inline-0\uE001"), "native entity decoding must retain authored text");
      assert.strictEqual(document.querySelector('[data-input="title-protected"], [data-input="image-protected"], [data-input="attribute-protected"]'), null, "native link titles, image alt and HTML attributes must not activate tags");
      assert.strictEqual(document.querySelector('blockquote [data-alert="quote"]')?.textContent, "quoted", "quote child must retain its native owner");
      assert.strictEqual(document.querySelector("h2")?.textContent, "Heading with title", "native heading level and unmarked prepared children must remain");
      assert.ok(document.querySelector('h2 [data-alert="heading"]'), "heading child component must render");
      assert.strictEqual(document.querySelector('div [data-alert="html"]')?.textContent, "leaf", "native HTML child component must render");
      assert.ok(document.querySelector('ul li [data-input="list"]'), "list child must retain its native owner");
      assert.ok(document.querySelector('li strong [data-input="list-emphasis"]'), "list emphasis must own an admitted inline component");
      assert.ok(document.querySelector('[data-alert="list-owned"] strong[data-inline-owner="configured"] [data-input="list-owned-child"]'), "list owned trees must use configured native inline renderers");
      assert.strictEqual(document.querySelector("code")?.textContent, '<Input placeholder="code" />', "protected code span must remain literal");
      assert.strictEqual(document.querySelector('[data-input="code"]'), null, "protected code span must not activate its tag");
      assert.ok(document.body.textContent?.includes("<Alert title={globalThis.__restrictedAdmissionSentinel()} />"), "invalid expression must remain literal");
      assert.strictEqual(sentinelCalls, 0, "restricted expression must not execute");
      assert.ok(document.body.textContent?.includes('<Card title="mismatch"><Alert title="unclosed">mismatch</Card>'), "mismatched nesting must preserve the whole authored source as literal");
      assert.strictEqual(document.querySelector('[data-card="mismatch"]'), null, "mismatched root must not be auto-closed into a host component");
    } finally {
      dom?.window.close();
      delete globalWithSentinel.__restrictedAdmissionSentinel;
    }
  });

  it("preserves parent-sensitive filters and disabled autolinks around list components", async () => {
    const harness = await createWorkerHarness();
    const messages = await harness.send({
      type: "INIT",
      initialContent: '- <Input /> [blocked](https://example.invalid/)\n- <Input /> **[nested-blocked](https://nested.example.invalid/)**\n- <Input /> contact@example.invalid\n- <Input /> <campaign-mark data-owned="kept">custom HTML</campaign-mark>\n',
      contentPolicy: "restricted",
      contentComponents: registeredComponents,
      html: { allowRaw: true, allowedTags: { "campaign-mark": ["data-owned"] } },
    });
    const initialized = findMessage(messages, "INITIALIZED");
    assert.ok(initialized);
    const Input = () => React.createElement("input", { "data-policy-owner": true });
    const contentComponents = { Input: defineContentComponent({ component: Input }) };
    const componentRegistry = new ComponentRegistry({}, {}, {}, {
      disableAutolinkProtocols: ["mailto"],
      allowElement: (element, context) => !(element.tagName === "a" && (
        (context.parentTagName === "li" && element.properties.href === "https://example.invalid/") ||
        (context.parentTagName === "strong" && element.properties.href === "https://nested.example.invalid/")
      )),
    });
    const dom = new JSDOM(renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: initialized.blocks, contentComponents, componentRegistry })));
    try {
      const forbiddenHrefs = [...dom.window.document.querySelectorAll("a")].map(anchor => anchor.getAttribute("href"))
        .filter(href => href === "https://example.invalid/" || href === "https://nested.example.invalid/" || href?.startsWith("mailto:"));
      const configuredTag = dom.window.document.querySelector("campaign-mark");
      assert.deepStrictEqual({ forbiddenHrefs, configuredText: configuredTag?.textContent, configuredAttribute: configuredTag?.getAttribute("data-owned") },
        { forbiddenHrefs: [], configuredText: "custom HTML", configuredAttribute: "kept" }, "owned list content must retain native parent/protocol filters and configured HTML policy");
      assert.ok(dom.window.document.body.textContent?.includes("contact@example.invalid"), "a disabled autolink must retain its visible text");
      assert.ok(dom.window.document.querySelector("[data-policy-owner]"), "the neighboring registered host must remain active");
    } finally {
      dom.window.close();
    }
  });

  it("publishes component footnotes beside native HTML only with their finalized definition", async () => {
    const harness = await createWorkerHarness();
    const messages = await harness.send({
      type: "INIT",
      initialContent: 'Before <Alert>inside[^owned]</Alert> with <em>ordinary</em>.\n\n- <Input /> outside[^owned] with <Alert>nested[^owned]</Alert>.\n\n[^owned]: Owned definition.\n',
      contentPolicy: "restricted",
      contentComponents: registeredComponents,
      docPlugins: { footnotes: true, html: true },
    });
    const initialized = findMessage(messages, "INITIALIZED");
    assert.ok(initialized);
    const Alert = ({ children }: { children?: React.ReactNode }) => React.createElement("span", { "data-footnote-owner": true }, children);
    const hostComponents = {
      Alert: defineContentComponent({ component: Alert, renderWhen: "closed" }),
      Input: defineContentComponent({ component: () => React.createElement("input") }),
    };
    const store = createRendererStore();
    store.reset(initialized.blocks);
    for (const message of messages) {
      if (message.type === "PATCH") store.applyPatches(message.patches, { captureMetrics: false });
    }
    const dom = new JSDOM(renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: initialized.blocks, contentComponents: hostComponents })));
    try {
      assert.strictEqual(dom.window.document.querySelector("sup.footnote-ref a"), null, "an unpublished definition must not produce a premature reference link");
      const finalMessages = await harness.send({ type: "FINALIZE" });
      for (const message of finalMessages) {
        if (message.type === "PATCH") store.applyPatches(message.patches, { captureMetrics: false });
      }
      dom.window.document.body.innerHTML = renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: store.getBlocks(), contentComponents: hostComponents }));
      assert.strictEqual(dom.window.document.querySelector('[data-footnote-owner] a[data-label="owned"]')?.textContent, "1");
      assert.ok(dom.window.document.querySelector('a[data-label="owned"]')?.getAttribute("href")?.startsWith("#fn:"));
      assert.strictEqual(dom.window.document.querySelector("em")?.textContent, "ordinary");
      assert.strictEqual(dom.window.document.querySelectorAll("li sup.footnote-ref a[data-label=\"owned\"]").length, 2, "both direct and component-owned list references must be numbered");
      for (const anchor of dom.window.document.querySelectorAll<HTMLAnchorElement>("sup.footnote-ref a, a.footnote-backref")) {
        assert.ok(dom.window.document.getElementById(anchor.hash.slice(1)), "every reference and backlink must target a rendered definition or occurrence");
      }
    } finally {
      dom.window.close();
    }
  });

  it("admits an unclosed ordinary HTML first block without owning the following paragraph", async () => {
    const harness = await createWorkerHarness();
    const messages = await harness.send({
      type: "INIT",
      initialContent: '<div><Input />\n\nOutside unclosed HTML.\n',
      contentPolicy: "restricted",
      contentComponents: registeredComponents,
    });
    const initialized = findMessage(messages, "INITIALIZED");
    assert.ok(initialized);
    const Input = () => React.createElement("input", { "data-open-html": true });
    const hostComponents = { Input: defineContentComponent({ component: Input }) };
    const dom = new JSDOM(renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: initialized.blocks, contentComponents: hostComponents })));
    try {
      const input = dom.window.document.querySelector("[data-open-html]");
      const paragraph = [...dom.window.document.querySelectorAll("p")].find(node => node.textContent === "Outside unclosed HTML.");
      assert.ok(input, "the first unclosed ordinary HTML block must admit its local host");
      assert.ok(paragraph, "the following native paragraph must remain visible");
      assert.ok(!input.closest("div")?.contains(paragraph), "unclosed HTML must not capture the following block");
    } finally {
      dom.window.close();
    }
  });

  it("does not activate registered components under contentPolicy: markdown", async () => {
    const harness = await createWorkerHarness();
    const messages = await harness.send({
      type: "INIT",
      initialContent: '<Input placeholder="markdown policy" />',
      contentPolicy: "markdown",
      contentComponents: registeredComponents,
    });
    const initialized = findMessage(messages, "INITIALIZED");
    assert.ok(initialized);

    const tree = initialized.blocks[0].payload.meta?.htmlTree as HtmlTreeNode[] | undefined;
    assert.ok(!tree?.some((node) => node.kind === "component"));
  });
});
