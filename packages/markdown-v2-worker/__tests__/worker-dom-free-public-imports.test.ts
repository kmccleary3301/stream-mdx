import assert from "node:assert";
import { spawnSync } from "node:child_process";

// Fresh processes exercise public package imports before any sibling fixture can
// install a DOM. Both package formats must leave the host's globals untouched.
const common = String.raw`
const globals = ["window", "document", "DOMParser", "HTMLElement", "Node"];
const before = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const unchanged = stage => {
  for (const key of globals) assert.deepStrictEqual(Object.getOwnPropertyDescriptor(globalThis, key), before.get(key), stage + " must not install " + key);
};
const assertMdx = blocks => {
  const owned = [];
  const visit = block => {
    if (block.type === "mdx") owned.push(block);
    for (const child of block.payload.meta?.preparedNested?.children ?? []) visitSnapshot(child);
  };
  const visitSnapshot = snapshot => {
    if (snapshot.props?.block) visit(snapshot.props.block);
    else for (const child of snapshot.children ?? []) visitSnapshot(child);
  };
  for (const block of blocks) visit(block);
  const mdx = owned.find(block => block.payload.raw.startsWith("<SmokeBox>"));
  assert.ok(mdx, "balanced component must retain its owning MDX block");
  assert.strictEqual(mdx.payload.meta.mdxStatus, "compiled", mdx.payload.meta.mdxError ?? "native MDX compilation failed");
  assert.ok(mdx.payload.compiledMdxModule.code.includes("©"), "native compiler must decode named entities without a DOM shim");
  assert.ok(mdx.payload.compiledMdxModule.code.includes("katex"), "native compiler must produce actual math artifacts");
  assert.ok(owned.some(block => block.payload.raw.startsWith("<Input") && block.payload.meta.mdxStatus === "compiled"), "case-sensitive Input component must compile without DOM globals");
  assert.ok(owned.some(block => block.payload.raw.startsWith("<QuoteBox>") && block.payload.meta.mdxStatus === "compiled" && block.payload.compiledMdxModule.code.includes("quotedAnswer")), "quote-owned fenced component must retain actual compiled code");
};
(async () => {
  const fence = String.fromCharCode(96).repeat(3);
  const text = ["<SmokeBox>", "", "native mdx &copy; $x$", "", "</SmokeBox>", "", '<Input label="case sensitive" />', "", "> <QuoteBox>", ">", "> " + fence + "js", "> const quotedAnswer = 42;", "> " + fence, ">", "> $y$", ">", "> </QuoteBox>", ""].join("\n");
  const init = { prewarmLangs: [], docPlugins: { html: true, math: true, mdx: true, tables: true, footnotes: true }, mdx: { compileMode: "worker" } };
  unchanged("public import");
  const direct = await compileMarkdownSnapshotDirect({ text, init });
  assertMdx(direct.blocks);
  unchanged("direct compilation");
  // The parent eval's --input-type applies only to string input, not worker files.
  const threaded = await compileMarkdownSnapshot({ text, init, workerOptions: { execArgv: [] } });
  assertMdx(threaded.blocks);
  assert.deepStrictEqual(threaded.blocks, direct.blocks, "physical hosted worker must retain exact DOM-free direct output");
  unchanged("physical worker compilation");
  const html = renderToStaticMarkup(React.createElement(StreamingMarkdown, { text: "Root[^n].\n\n[^n]: Note.\n" }));
  assert.ok(typeof html === "string", "actual SSR component must render without a fake document");
  unchanged("React SSR");
  console.log("public DOM-free import, direct, physical MDX worker and React SSR passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

for (const format of ["esm", "cjs"] as const) {
  const cjsPrelude = 'const assert = require("node:assert"); const React = require("react"); const { renderToStaticMarkup } = require("react-dom/server"); const { StreamingMarkdown } = require("@stream-mdx/react"); const { compileMarkdownSnapshotDirect } = require("@stream-mdx/worker/direct"); const { compileMarkdownSnapshot } = require("@stream-mdx/worker/node"); require("@stream-mdx/worker/engine");';
  // Capture descriptors before loading the packages, including ESM import effects.
  const script = format === "esm"
    ? 'import assert from "node:assert"; const descriptors = new Map(["window", "document", "DOMParser", "HTMLElement", "Node"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])); const React = (await import("react")).default; const { renderToStaticMarkup } = await import("react-dom/server"); const { StreamingMarkdown } = await import("@stream-mdx/react"); const { compileMarkdownSnapshotDirect } = await import("@stream-mdx/worker/direct"); const { compileMarkdownSnapshot } = await import("@stream-mdx/worker/node"); await import("@stream-mdx/worker/engine"); for (const [key, value] of descriptors) assert.deepStrictEqual(Object.getOwnPropertyDescriptor(globalThis, key), value, "import must not install " + key);' + common
    : 'const descriptors = new Map(["window", "document", "DOMParser", "HTMLElement", "Node"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));' + cjsPrelude + 'for (const [key, value] of descriptors) assert.deepStrictEqual(Object.getOwnPropertyDescriptor(globalThis, key), value, "import must not install " + key);' + common;
  const result = spawnSync(process.execPath, [...(format === "esm" ? ["--input-type=module"] : []), "-e", script], { encoding: "utf8", timeout: 30_000 });
  assert.strictEqual(result.status, 0, `${format} public DOM-free consumer failed: ${result.stdout}\n${result.stderr}`);
  process.stdout.write(`${format}: ${result.stdout}`);
}
