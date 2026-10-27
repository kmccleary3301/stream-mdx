import assert from "node:assert/strict";
import React from "react";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { STREAM_MDX_SCHEMA_VERSION, type Block, type HtmlTreeNode, type WorkerOut } from "@stream-mdx/core";
import { MarkdownBlocksRenderer, createRendererStore } from "@stream-mdx/react/server";
import { createWorkerHarness, type WorkerHarness } from "./worker-test-harness";

const DOC_PLUGINS = {
  callouts: "github-alerts",
  footnotes: true,
  html: true,
  listIndentation: true,
  math: true,
  mdx: false,
  tables: true,
} as const;
const HTML = { mode: "sanitize", unmatchedAnchors: "literal-bare", standaloneSvg: "code" } as const;
const CASES = [
  {
    name: "unmatched self-closing anchor stays inside list strong text",
    source: '- **"Using <A/>"** appears in the header.\n\n- **Tests:** cover inheritance.',
    verify(blocks: readonly Block[], text: string, document: Document) {
      const list = blocks.find((block) => block.type === "list");
      const prepared = list?.payload.meta?.preparedNested as { children?: unknown[] } | undefined;
      const firstItem = prepared?.children?.[0];
      const strongs = findRecords(firstItem, (record) => record.kind === "strong");
      assert.ok(strongs.some((node) => inlineText(node) === '"Using <A/>"'), JSON.stringify(blocks));
      assert.ok(!findRecords(firstItem, (record) => record.type === "mdx" || record.kind === "trusted-mdx-inline").length);
      assert.equal(document.querySelector("ul li strong")?.textContent, '"Using <A/>"');
      assert.ok(text.includes('"Using <A/>"'));
    },
  },
  {
    name: "anchor closed by a later standalone HTML block",
    source: "See <a>label\n\n</a>\n\nfinish",
    verify(blocks: readonly Block[], text: string) {
      assert.ok(text.includes("See label"), JSON.stringify(blocks));
      assert.ok(!text.includes("<a>"), JSON.stringify(blocks));
    },
  },
  {
    name: "anchor scan treats script content as raw text",
    source: "See <a>label<script><!-- </script> --></a>",
    verify(_blocks: readonly Block[], text: string) {
      assert.equal(text.trim(), "See label -->");
    },
  },
] as const;

function findRecords(value: unknown, predicate: (record: Record<string, unknown>) => boolean): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      item.forEach(visit);
    } else if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      if (predicate(record)) found.push(record);
      Object.values(record).forEach(visit);
    }
  };
  visit(value);
  return found;
}

function inlineText(value: unknown): string {
  if (Array.isArray(value)) return value.map(inlineText).join("");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (record.kind === "text") return typeof record.text === "string" ? record.text : "";
  return inlineText(record.children);
}

function projectInline(value: unknown): unknown {
  if (Array.isArray(value)) {
    const projected: unknown[] = [];
    for (const item of value) {
      const node = projectInline(item);
      const previous = projected.at(-1);
      if (
        node && typeof node === "object" && (node as Record<string, unknown>).kind === "text" &&
        previous && typeof previous === "object" && (previous as Record<string, unknown>).kind === "text"
      ) {
        const previousText = previous as Record<string, unknown>;
        const nodeText = node as Record<string, unknown>;
        previousText.text = `${String(previousText.text ?? "")}${String(nodeText.text ?? "")}`;
      } else {
        projected.push(node);
      }
    }
    return projected;
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === "sourceRange") continue;
    projected[key] = key === "children" || key === "inline" ? projectInline(item) : item;
  }
  return projected;
}

function projectNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectNode);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const props = record.props;
  const projectedProps = props && typeof props === "object" && !Array.isArray(props)
    ? { ...(props as Record<string, unknown>), inline: projectInline((props as Record<string, unknown>).inline) }
    : props;
  return {
    type: record.type,
    range: record.range,
    props: projectedProps,
    children: projectNode(record.children),
  };
}

function projectHtmlTree(nodes: unknown): unknown {
  if (!Array.isArray(nodes)) return undefined;
  return nodes.map((node: HtmlTreeNode) => {
    if (node.kind === "block") return { kind: node.kind, block: stableBlock(node.block) };
    if (node.kind === "text") return { kind: node.kind, text: node.text, inline: projectInline(node.inline), rawSource: node.rawSource };
    if (node.kind === "element") {
      return { kind: node.kind, tagName: node.tagName, attributes: node.attributes, paragraphRoot: node.paragraphRoot, children: projectHtmlTree(node.children) };
    }
    return { kind: node.kind, name: node.name, status: node.status, props: node.props, children: projectHtmlTree(node.children) };
  });
}

function stableBlock(block: Block): unknown {
  const meta = block.payload.meta ?? {};
  const prepared = meta.preparedNested as { children?: unknown[] } | undefined;
  return {
    type: block.type,
    raw: block.payload.raw,
    range: block.payload.range,
    isFinalized: block.isFinalized,
    inline: projectInline(block.payload.inline),
    sanitizedHtml: block.payload.sanitizedHtml,
    preparedNested: projectNode(prepared?.children),
    htmlTree: projectHtmlTree(meta.htmlTree),
    htmlParagraphTree: projectHtmlTree(meta.htmlParagraphTree),
  };
}


function renderedText(blocks: readonly Block[]): { readonly text: string; readonly document: Document } {
  const markup = renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: [...blocks] }));
  const document = new JSDOM(markup).window.document;
  return { text: document.body.textContent ?? "", document };
}

async function finalizedBlocks(harness: WorkerHarness, chunks: readonly string[]): Promise<readonly Block[]> {
  const store = createRendererStore();
  const apply = (messages: readonly WorkerOut[]) => {
    for (const message of messages) {
      if (message.type === "ERROR") assert.fail(`Worker error during ${message.phase}: ${message.error.message}`);
      if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
      else if (message.type === "PATCH") store.applyPatches(message.patches, { captureMetrics: false });
    }
  };
  apply(await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: [],
    docPlugins: DOC_PLUGINS,
    html: HTML,
  }));
  for (const chunk of chunks) apply(await harness.send({ type: "APPEND", text: chunk }));
  apply(await harness.send({ type: "FINALIZE" }));
  return store.getBlocks();
}

const harness = await createWorkerHarness();
const failures: string[] = [];
for (const testCase of CASES) {
  const expectedBlocks = await finalizedBlocks(harness, [testCase.source]);
  const expectedText = renderedText(expectedBlocks);
  try {
    testCase.verify(expectedBlocks, expectedText.text, expectedText.document);
  } catch (error) {
    failures.push(`${testCase.name}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  const expectedProjection = JSON.parse(JSON.stringify(expectedBlocks.map(stableBlock)));
  for (let split = 1; split < testCase.source.length; split += 1) {
    const streamedBlocks = await finalizedBlocks(harness, [testCase.source.slice(0, split), testCase.source.slice(split)]);
    try {
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(streamedBlocks.map(stableBlock))),
        expectedProjection,
        `${testCase.name}: append split ${split} changed finalized blocks`,
      );
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
}
assert.deepStrictEqual(failures, [], failures.join("\n"));
console.log("Raw anchor pairing streaming parity tests passed");
