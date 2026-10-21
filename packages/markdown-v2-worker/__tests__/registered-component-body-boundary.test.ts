import assert from "node:assert";
import { describe, it } from "node:test";
import type { Block, HtmlTreeNode, WorkerOut } from "@stream-mdx/core";
import { MarkdownEngine } from "../src/engine/engine";

const registeredComponents = [{ name: "Preview", renderWhen: "closed" as const }];

type ComponentNode = Extract<HtmlTreeNode, { kind: "component" }>;

async function parseRegistered(content: string): Promise<Block[]> {
  const messages: WorkerOut[] = [];
  const engine = new MarkdownEngine({ post: (message) => messages.push(message) });
  await engine.handle({
    type: "INIT",
    initialContent: content,
    prewarmLangs: [],
    contentPolicy: "restricted",
    contentComponents: registeredComponents,
  });
  engine.dispose();
  const initialized = messages.find((message) => message.type === "INITIALIZED");
  assert.ok(initialized && initialized.type === "INITIALIZED", "the Worker must expose initialized blocks");
  return initialized.blocks;
}

function componentsIn(blocks: readonly Block[]): ComponentNode[] {
  const components: ComponentNode[] = [];
  for (const block of blocks) {
    const tree = block.payload.meta?.htmlTree as HtmlTreeNode[] | undefined;
    for (const node of tree ?? []) {
      if (node.kind === "component") components.push(node);
    }
  }
  return components;
}

function nativeChildren(component: ComponentNode): Block[] {
  const blocks: Block[] = [];
  for (const child of component.children) {
    if (child.kind === "block") blocks.push(child.block);
  }
  return blocks;
}

describe("registered component opening-header boundary", () => {
  it("keeps same-line and multiline registered headers separate from native body blocks", async () => {
    const source = [
      "<Preview",
      '  title={"multiline > value"}',
      ">first-line body text",
      "### Native heading",
      "",
      "Native paragraph with **bold** text.",
      "",
      "- Native list item",
      "",
      "```ts",
      "const answer = 42;",
      "```",
      "</Preview>",
      "",
      '<Preview title="single-line">single-line body text',
      "## Second native heading",
      "</Preview>",
    ].join("\n");

    const blocks = await parseRegistered(source);
    const components = componentsIn(blocks);
    assert.strictEqual(components.length, 2, "both registered wrappers must remain admitted components");

    const multiline = components[0];
    assert.strictEqual(multiline.name, "Preview");
    assert.strictEqual(multiline.props.title, "multiline > value");
    assert.ok(multiline.rawSource.includes("first-line body text"), "text after the closing delimiter on the header line must be retained");
    const children = nativeChildren(multiline);
    assert.deepStrictEqual(children.map((block) => block.type), ["heading", "paragraph", "list", "code"]);
    assert.strictEqual(children[0].payload.meta?.headingLevel, 3, "the unseparated ATX line must use native heading grammar");
    assert.strictEqual(children[0].payload.meta?.headingText, "Native heading");
    assert.strictEqual(children[0].payload.range?.from, source.indexOf("### Native heading"), "native child offsets must remain document-relative");
    assert.match(children[1].payload.raw, /Native paragraph with \*\*bold\*\* text/);
    assert.match(String(children[2].payload.raw), /Native list item/);
    assert.match(String(children[3].payload.meta?.code), /const answer = 42;/);

    const sameLine = components[1];
    assert.strictEqual(sameLine.props.title, "single-line");
    assert.ok(sameLine.rawSource.includes("single-line body text"), "same-line header suffix must not be dropped");
    const sameLineChildren = nativeChildren(sameLine);
    assert.deepStrictEqual(sameLineChildren.map((block) => block.type), ["heading"]);
    assert.strictEqual(sameLineChildren[0].payload.meta?.headingLevel, 2);
    assert.strictEqual(sameLineChildren[0].payload.range?.from, source.indexOf("## Second native heading"));
  });

  it("preserves CommonMark uppercase HTML and does not activate tags in code or comments", async () => {
    const source = [
      "<DIV>",
      "### Literal HTML-block content",
      "",
      "```md",
      '<Preview title="inside code" />',
      "```",
      "",
      '<!-- <Preview title="inside comment" /> -->',
      "",
      "Native paragraph after the protected constructs.",
    ].join("\n");

    const blocks = await parseRegistered(source);
    assert.strictEqual(componentsIn(blocks).length, 0, "ordinary HTML, code, and comments must not become registered components");

    const html = blocks.find((block) => block.type === "html" && block.payload.raw.includes("<DIV>"));
    assert.ok(html, "uppercase DIV must remain a native CommonMark HTML block");
    assert.match(html.payload.raw, /### Literal HTML-block content/, "heading syntax inside the type-6 HTML block must remain literal");
    assert.strictEqual(blocks.some((block) => block.type === "heading"), false, "HTML-block contents must not enter heading grammar");

    const code = blocks.find((block) => block.type === "code");
    assert.ok(code, "a fenced body line must remain native code");
    assert.match(String(code.payload.meta?.code), /<Preview title="inside code" \/>/);
    const comment = blocks.find((block) => block.type === "html" && block.payload.raw.includes("<!--"));
    assert.ok(comment, "the HTML comment must remain a native comment block");
    assert.match(comment.payload.raw, /<Preview title="inside comment" \/>/);
    assert.ok(blocks.some((block) => block.type === "paragraph" && block.payload.raw.includes("Native paragraph after")));
  });

  it("does not admit incomplete or invalid registered opening headers", async () => {
    const source = [
      '<Preview title="unfinished',
      "",
      "### Native heading after incomplete header",
      "",
      "<Preview 12345>",
      "",
      "### Native heading after invalid header",
    ].join("\n");

    const blocks = await parseRegistered(source);
    assert.strictEqual(componentsIn(blocks).length, 0, "unresolved or strict-grammar-invalid headers must not be admitted");
    const headings = blocks.filter((block) => block.type === "heading");
    assert.deepStrictEqual(headings.map((block) => block.payload.meta?.headingText), [
      "Native heading after incomplete header",
      "Native heading after invalid header",
    ]);
    assert.ok(blocks.some((block) => block.payload.raw.includes('<Preview title="unfinished')));
    assert.ok(blocks.some((block) => block.payload.raw.includes("<Preview 12345>")));
  });
});
