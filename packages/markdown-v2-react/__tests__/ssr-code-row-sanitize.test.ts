import assert from "node:assert";

import { sanitizeCodeHTML, type Block } from "@stream-mdx/core";
import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MarkdownBlocksRenderer, createRendererStore, type RendererStore } from "../src/server";

// Node/SSR prerender has no DOM `window`, so the code-row sanitizer must use
// the shared DOM-free pipeline (@stream-mdx/core worker-html-sanitizer) instead
// of throwing. jsdom-based tests in this package create their own windows and
// never read a global one, so toggling the global here is contained.
interface WindowCapableGlobal {
  window?: unknown;
}
const globalScope = globalThis as WindowCapableGlobal;
const previousWindow = globalScope.window;
delete globalScope.window;

// Real compiled output for `` ```tsx\n<StreamingMarkdown worker="/workers/markdown-worker.js" />\n``` ``
// (apps/docs .generated snapshot docs/security-model.json): a small Shiki
// github-dark/github-light fence carrying per-line html.
const REAL_SHIKI_FENCE_SOURCE = '<StreamingMarkdown worker="/workers/markdown-worker.js" />';
const REAL_SHIKI_FENCE_HTML =
  '<pre class="shiki shiki-themes github-dark github-light" style="--shiki-dark:#e1e4e8;--shiki-light:#24292e;--shiki-dark-bg: transparent;--shiki-light-bg: transparent" tabindex="undefined" data-language="tsx"><code data-language="tsx" data-theme="github-dark github-light" style="display: grid;"><span class="line" data-line="1"><span style="--shiki-dark:#E1E4E8;--shiki-light:#24292E">&#x3C;</span><span style="--shiki-dark:#79B8FF;--shiki-light:#005CC5">StreamingMarkdown</span><span style="--shiki-dark:#B392F0;--shiki-light:#6F42C1"> worker</span><span style="--shiki-dark:#F97583;--shiki-light:#D73A49">=</span><span style="--shiki-dark:#9ECBFF;--shiki-light:#032F62">"/workers/markdown-worker.js"</span><span style="--shiki-dark:#E1E4E8;--shiki-light:#24292E"> /></span></span></code></pre>';

const HOSTILE_CODE_ROW =
  '<span class="line" data-line="2"><script>alert(1)</script><img src="x" onerror="alert(1)"><span onclick="alert(1)">click</span><span style="background:url(javascript:alert(1))">urlstyle</span><a href="javascript:alert(1)">link</a><span style="color:#24292e">safe</span></span>';

const realFenceBlock: Block = {
  id: "ssr-shiki-fence",
  type: "code",
  isFinalized: true,
  payload: {
    raw: `\`\`\`tsx\n${REAL_SHIKI_FENCE_SOURCE}\n\`\`\``,
    meta: { lang: "tsx", code: REAL_SHIKI_FENCE_SOURCE },
    highlightedHtml: REAL_SHIKI_FENCE_HTML,
  },
};

const hostileBlock: Block = {
  id: "ssr-hostile-row",
  type: "code",
  isFinalized: true,
  payload: {
    raw: "```tsx\nalpha\nbeta\n```",
    meta: { lang: "tsx", code: "alpha\nbeta" },
    highlightedHtml: `<pre class="shiki"><code><span class="line" data-line="1">alpha</span>${HOSTILE_CODE_ROW}</code></pre>`,
  },
};

function readLineHtml(store: RendererStore, id: string): string {
  const node = store.getNode(id);
  assert.ok(node, `expected rendered code row ${id}`);
  const html = node?.props?.html;
  if (typeof html !== "string") {
    throw new Error(`expected html string for ${id}`);
  }
  return html;
}

/**
 * Canonical DOM serialization so browser/Node outputs are compared by DOM
 * semantics (tags, attributes, text) instead of serializer formatting.
 */
function normalizeHtml(html: string): string {
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  const root = dom.window.document.getElementById("root");
  if (!root) {
    throw new Error("normalizeHtml root missing");
  }
  return root.innerHTML;
}

// DOMPurify `DEFAULT_FORBID_CONTENTS` subtrees are removed with their content
// on both paths; other disallowed tags are unwrapped and keep their content.
// Tags that the HTML parser flattens outside their context (`thead`, `head`)
// cannot be asserted this way; the table case below reaches `thead` as a real
// element instead.
const FORBIDDEN_SUBTREE_TAGS = ["svg", "template", "iframe", "math", "title", "xmp", "video", "noscript"];
const UNWRAPPED_TAGS = ["textarea", "em", "h1"];

const ALIGNMENT_MATRIX = [
  REAL_SHIKI_FENCE_HTML,
  HOSTILE_CODE_ROW,
  '<span class="line"><span style="--shiki-dark:#e1e4e8;--shiki-light:#24292e">alpha</span></span>',
  '<span class="line" data-line="3" style="color:#24292e;font-style:italic">styled</span>',
  '<div class="shiki" data-theme="dark"><pre class="shiki"><code><span class="line">const x = 1;</span></code></pre></div>',
  '<span class="line">text <em>kept</em> <a href="https://example.com">link</a> <h1>block</h1></span>',
  '<span class="line"><!-- note -->kept</span>',
  '<span class="line"><script>alert(1)</script>after</span>',
  '<span aria-hidden="true" id="x" tabindex="0" class="line" data-line="4">attrs</span>',
  '<span class="line" style="background-image:\\75rl(https://attacker.example/pixel)">escaped</span>',
  '<span class="line" style="background-image:u/**/rl(https://attacker.example/pixel)">commented</span>',
  '<span class="line" style="background-image:url(https://attacker.example/pixel)">urled</span>',
  '<span class="line" style="position:fixed;color:#24292e">mixed</span>',
  ...FORBIDDEN_SUBTREE_TAGS.map((tag) => `<span class="line">pre<${tag}>hidden</${tag}>post</span>`),
  ...UNWRAPPED_TAGS.map((tag) => `<span class="line">pre<${tag}>kept</${tag}>post</span>`),
  '<span class="line">A<table><thead><tr><td>cell</td></tr></thead></table>B</span>',
];

const CSS_ESCAPE_BYPASSES = [
  '<span class="line" style="background-image:\\75rl(https://attacker.example/pixel)">escaped</span>',
  '<span class="line" style="background-image:u/**/rl(https://attacker.example/pixel)">commented</span>',
  '<span class="line" style="background-image:url(https://attacker.example/pixel)">urled</span>',
];

function restoreWindow(): void {
  if (typeof previousWindow === "undefined") {
    delete globalScope.window;
  } else {
    globalScope.window = previousWindow;
  }
}

async function main(): Promise<void> {
  assert.strictEqual(typeof globalScope.window, "undefined", "SSR phase requires no global window");

  // 1. Store hydration of a real compiled Shiki fence keeps code rows and theme colors.
  const realStore = createRendererStore([realFenceBlock]);
  const realLine = readLineHtml(realStore, "ssr-shiki-fence::line:0");
  assert.ok(realLine.includes("--shiki-dark:#E1E4E8"), "Shiki CSS variables must survive DOM-free sanitation");
  assert.ok(realLine.includes("StreamingMarkdown"), "highlighted source text must survive");
  assert.ok(realLine.includes("--shiki-light:#24292E"), "Shiki light-theme variables must survive");

  // 2. Untrusted row markup is rejected at the consumer boundary, content kept.
  const hostileStore = createRendererStore([hostileBlock]);
  const hostileLine = readLineHtml(hostileStore, "ssr-hostile-row::line:1");
  assert.ok(!/<script/i.test(hostileLine), "script tags must be rejected in SSR code rows");
  assert.ok(!/<img/i.test(hostileLine), "non-code elements must be rejected in SSR code rows");
  assert.ok(!/onerror/i.test(hostileLine), "event handler attributes must be rejected in SSR code rows");
  assert.ok(!/onclick/i.test(hostileLine), "event handler attributes must be rejected in SSR code rows");
  assert.ok(!/javascript:/i.test(hostileLine), "javascript: URLs and styles must be rejected in SSR code rows");
  assert.ok(hostileLine.includes("color:#24292e"), "benign theme styles must survive");
  for (const fragment of ["click", "link", "urlstyle", "safe"]) {
    assert.ok(hostileLine.includes(fragment), `row content "${fragment}" must be retained`);
  }

  // 3. MarkdownBlocksRenderer SSR markup for the same blocks stays safe without a DOM.
  const ssr = renderToStaticMarkup(
    React.createElement(MarkdownBlocksRenderer, { blocks: [realFenceBlock, hostileBlock] }),
  );
  assert.ok(ssr.includes("--shiki-dark:#E1E4E8"), "SSR code markup must retain Shiki colors");
  assert.ok(!/<script/i.test(ssr), "SSR code markup must not contain scripts");
  assert.ok(!/onerror/i.test(ssr), "SSR code markup must not contain event handlers");
  assert.ok(!/onclick/i.test(ssr), "SSR code markup must not contain event handlers");
  assert.ok(!/javascript:/i.test(ssr), "SSR code markup must not contain javascript: payloads");
  const ssrDom = new JSDOM(ssr);
  const codeText = Array.from(ssrDom.window.document.querySelectorAll("pre code"))
    .map((node) => node.textContent ?? "")
    .join("\n");
  assert.ok(codeText.includes(REAL_SHIKI_FENCE_SOURCE), `SSR code text must retain the source: ${codeText}`);

  // 3b. CSS backslash-escape / comment bypass attempts lose their styles DOM-free.
  for (const input of CSS_ESCAPE_BYPASSES) {
    const out = sanitizeCodeHTML(input);
    assert.ok(!/background-image/i.test(out), `DOM-free path must drop hostile styles: ${out}`);
    assert.ok(!/\\75|url\s*\(|u\/\*\*\/rl/.test(out), `DOM-free path must not keep escaped url(): ${out}`);
    assert.ok(/escaped|commented|urled/.test(out), `DOM-free path must keep row content: ${out}`);
  }

  // 3c. Forbidden-content subtrees are removed with their contents (DOMPurify
  // DEFAULT_FORBID_CONTENTS parity); other disallowed tags stay unwrapped.
  for (const tag of FORBIDDEN_SUBTREE_TAGS) {
    const out = sanitizeCodeHTML(`<span class="line">pre<${tag}>hidden</${tag}>post</span>`);
    assert.ok(!out.includes("hidden"), `forbidden subtree content must be removed (${tag}): ${out}`);
    assert.ok(out.includes("pre") && out.includes("post"), `siblings must survive (${tag}): ${out}`);
  }
  for (const tag of UNWRAPPED_TAGS) {
    const out = sanitizeCodeHTML(`<span class="line">pre<${tag}>kept</${tag}>post</span>`);
    assert.ok(out.includes("kept"), `unwrapped tag content must survive (${tag}): ${out}`);
    assert.ok(!out.includes(`<${tag}`), `tag itself must be removed (${tag}): ${out}`);
  }
  const tableSubtree = sanitizeCodeHTML(
    '<span class="line">A<table><thead><tr><td>cell</td></tr></thead></table>B</span>',
  );
  assert.ok(!tableSubtree.includes("cell"), `table header subtree must be removed: ${tableSubtree}`);

  // 4. Browser path (DOMPurify + template scrub) and Node path must agree per DOM semantics.
  const nodeOutputs = ALIGNMENT_MATRIX.map((input) => normalizeHtml(sanitizeCodeHTML(input)));
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalScope.window = dom.window;
  try {
    ALIGNMENT_MATRIX.forEach((input, index) => {
      const browserOutput = normalizeHtml(sanitizeCodeHTML(input));
      assert.strictEqual(
        browserOutput,
        nodeOutputs[index],
        `browser and Node code-row sanitation must agree (matrix input ${index})`,
      );
    });
    const browserHostile = sanitizeCodeHTML(HOSTILE_CODE_ROW);
    assert.ok(!/onerror/i.test(browserHostile), "browser path must drop event handlers");
    assert.ok(!/javascript:/i.test(browserHostile), "browser path must drop javascript: payloads");
    assert.ok(browserHostile.includes("color:#24292e"), "browser path must keep benign theme styles");
    const benignCustomProps = sanitizeCodeHTML(
      '<span class="line"><span style="--shiki-dark:#e1e4e8;--shiki-light:#24292e">alpha</span></span>',
    );
    assert.ok(
      benignCustomProps.includes("--shiki-dark:#e1e4e8"),
      `browser path must keep benign theme variables: ${benignCustomProps}`,
    );
  } finally {
    restoreWindow();
  }

  console.log("ssr-code-row-sanitize test passed");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(restoreWindow);
