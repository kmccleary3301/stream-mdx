import assert from "node:assert";
import React from "react";
import ReactDOMServer from "react-dom/server";
import rehypeSlug from "rehype-slug";
import { visit } from "unist-util-visit";
import type { Block } from "@stream-mdx/core";
import type { Node } from "unist";
import { ComponentRegistry, MarkdownBlocksRenderer } from "@stream-mdx/react";
import { createUnifiedRenderer, extractLinkDefinitions } from "../src";

function normalizeHtml(html: string): string {
  return html.replace(/\s+/g, " ").trim();
}

async function runTests() {
  console.log("Starting @stream-mdx/unified acceptance tests...");

  // Test 1: rehype-slug plugin adds id to finalized heading
  {
    console.log("Test 1: rehype-slug on finalized heading...");
    const unifiedRenderer = createUnifiedRenderer({
      rehypePlugins: [rehypeSlug],
    });

    const headingBlock: Block = {
      id: "h1-test",
      type: "heading",
      isFinalized: true,
      payload: {
        raw: "## Quick Start Guide",
      },
    };

    const defaultElement = React.createElement("h2", null, "Quick Start Guide");
    const rendered = unifiedRenderer({
      block: headingBlock,
      element: defaultElement,
    });

    const html = ReactDOMServer.renderToStaticMarkup(rendered as React.ReactElement);
    assert.match(html, /id="quick-start-guide"/, "Finalized heading should have slugified id");
    assert.match(html, />Quick Start Guide<\/h2>/, "Heading text should match");
    console.log("✓ Test 1 passed: Finalized heading received id attribute from rehype-slug");
  }

  // Test 2: remark uppercase plugin changes output only after finalize
  {
    console.log("Test 2: remark uppercase plugin changes output only after finalize...");
    function remarkUppercase() {
      return (tree: unknown) => {
        visit(tree as Node, "text", (node: { value: string }) => {
          node.value = node.value.toUpperCase();
        });
      };
    }

    const unifiedRenderer = createUnifiedRenderer({
      remarkPlugins: [remarkUppercase],
    });

    const unfinalizedBlock: Block = {
      id: "p1-streaming",
      type: "paragraph",
      isFinalized: false,
      payload: {
        raw: "streaming text",
      },
    };

    const defaultElement = React.createElement("p", { className: "default-p" }, "streaming text");

    // While streaming (unfinalized), should return default untouched element
    const streamingRendered = unifiedRenderer({
      block: unfinalizedBlock,
      element: defaultElement,
    });
    const streamingHtml = ReactDOMServer.renderToStaticMarkup(streamingRendered as React.ReactElement);
    assert.strictEqual(
      streamingHtml,
      '<p class="default-p">streaming text</p>',
      "Unfinalized block must return normal default renderer output",
    );

    // Once finalized, should return uppercase output
    const finalizedBlock: Block = {
      ...unfinalizedBlock,
      isFinalized: true,
    };
    const finalizedRendered = unifiedRenderer({
      block: finalizedBlock,
      element: defaultElement,
    });
    const finalizedHtml = ReactDOMServer.renderToStaticMarkup(finalizedRendered as React.ReactElement);
    assert.strictEqual(
      finalizedHtml,
      "<p>STREAMING TEXT</p>",
      "Finalized block must be transformed by unified remark plugin",
    );
    console.log("✓ Test 2 passed: Remark plugin only transforms after block is finalized");
  }

  // Test 3: reference links resolve inside a routed paragraph
  {
    console.log("Test 3: reference links resolve inside a routed paragraph...");
    const documentText = '[stream-docs]: https://stream-mdx.dev "Official Docs"\n\nVisit [stream-docs] for more.';
    const unifiedRenderer = createUnifiedRenderer({
      components: {
        a: (props) => React.createElement("a", { ...props, className: "custom-ref-link" }),
      },
    });

    const paragraphBlock: Block = {
      id: "p-ref-test",
      type: "paragraph",
      isFinalized: true,
      payload: {
        raw: "Visit [stream-docs] for more.",
      },
    };

    const defaultElement = React.createElement("p", null, "Visit [stream-docs] for more.");
    const rendered = unifiedRenderer({
      block: paragraphBlock,
      element: defaultElement,
      context: {
        documentText,
      },
    });

    const html = ReactDOMServer.renderToStaticMarkup(rendered as React.ReactElement);
    assert.match(
      html,
      /href="https:\/\/stream-mdx\.dev"/,
      "Reference link should resolve destination URL",
    );
    assert.match(
      html,
      /title="Official Docs"/,
      "Reference link should resolve title attribute",
    );
    assert.match(
      html,
      /class="custom-ref-link"/,
      "Custom component mapping should be applied to resolved link",
    );
    console.log("✓ Test 3 passed: Reference links resolve properly using document context");
  }

  // Test 4: streaming in 1-char chunks yields the same final DOM as static
  {
    console.log("Test 4: 1-char chunk streaming yields identical final DOM to static...");
    const unifiedRenderer = createUnifiedRenderer({
      rehypePlugins: [rehypeSlug],
    });

    const blocksData = [
      { id: "b1", type: "heading", raw: "# Architecture Overview" },
      { id: "b2", type: "paragraph", raw: "StreamMDX engine provides high throughput streaming." },
    ];

    // Static rendering
    const staticBlocks: Block[] = blocksData.map((b) => ({
      id: b.id,
      type: b.type,
      isFinalized: true,
      payload: { raw: b.raw },
    }));

    const staticHtml = ReactDOMServer.renderToStaticMarkup(
      React.createElement(MarkdownBlocksRenderer, {
        blocks: staticBlocks,
        blockRenderer: unifiedRenderer,
      }),
    );

    // Simulate streaming: blocks start dirty, text streams character by character, then finalizes
    let streamedBlocks: Block[] = [];
    for (const b of blocksData) {
      let currentRaw = "";
      for (let i = 0; i < b.raw.length; i++) {
        currentRaw += b.raw[i];
        streamedBlocks = [
          ...staticBlocks.filter((sb) => sb.id !== b.id && staticBlocks.indexOf(sb) < blocksData.findIndex((x) => x.id === b.id)),
          {
            id: b.id,
            type: b.type,
            isFinalized: false,
            payload: { raw: currentRaw },
          },
        ];
      }
    }

    // Finalize all blocks at completion of stream
    streamedBlocks = blocksData.map((b) => ({
      id: b.id,
      type: b.type,
      isFinalized: true,
      payload: { raw: b.raw },
    }));

    const finalStreamedHtml = ReactDOMServer.renderToStaticMarkup(
      React.createElement(MarkdownBlocksRenderer, {
        blocks: streamedBlocks,
        blockRenderer: unifiedRenderer,
      }),
    );

    assert.strictEqual(
      normalizeHtml(finalStreamedHtml),
      normalizeHtml(staticHtml),
      "Streaming in 1-char chunks must yield identical final DOM to static rendering",
    );
    console.log("✓ Test 4 passed: 1-char chunk streaming produces identical final DOM to static");
  }

  // Test 5: Cache efficiency
  {
    console.log("Test 5: Cache avoids recomputing finalized blocks...");
    let parseCalls = 0;
    function countingPlugin() {
      return () => {
        parseCalls += 1;
      };
    }

    const unifiedRenderer = createUnifiedRenderer({
      remarkPlugins: [countingPlugin],
    });

    const block: Block = {
      id: "cached-block",
      type: "paragraph",
      isFinalized: true,
      payload: { raw: "Cached paragraph test." },
    };

    const el1 = unifiedRenderer({ block, element: React.createElement("p") });
    ReactDOMServer.renderToStaticMarkup(el1 as React.ReactElement);
    assert.strictEqual(parseCalls, 1, "First render should call plugin");

    // Second render with same block id & raw
    const el2 = unifiedRenderer({ block, element: React.createElement("p") });
    ReactDOMServer.renderToStaticMarkup(el2 as React.ReactElement);
    assert.strictEqual(parseCalls, 1, "Second render should use cached output without re-running plugin");

    // Clear cache
    unifiedRenderer.clearCache();
    const el3 = unifiedRenderer({ block, element: React.createElement("p") });
    ReactDOMServer.renderToStaticMarkup(el3 as React.ReactElement);
    assert.strictEqual(parseCalls, 2, "After clearCache(), plugin should run again");
    console.log("✓ Test 5 passed: Finalized block caching works as expected");
  }

  console.log("All @stream-mdx/unified tests passed successfully!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
