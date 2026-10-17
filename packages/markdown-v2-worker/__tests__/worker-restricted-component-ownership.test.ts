import assert from "node:assert";
import { describe, it } from "node:test";
import type { HtmlTreeNode, WorkerIn, WorkerOut } from "@stream-mdx/core";
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
