import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { collectGeneratedFootnoteLabels, collectSemanticDom } from "./semantic-dom";
import { createChunkTrace } from "./chunk-trace";
import { collectCodeReadiness } from "./code-readiness";
import { comparisonInvalidity, type ComparisonEvidence } from "./comparison-guards";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const collect = (html: string) => collectSemanticDom(new JSDOM(`<main>${html}</main>`).window.document.querySelector("main")!);
const native = collect('<h2>Title</h2><pre><code class="language-js">  first\n\n  last</code></pre><p>Done</p>');
const streamdown = collect('<h2>Title</h2><div data-streamdown="code-block" data-language="js"><div data-streamdown="code-block-header">js</div><pre><code><span>  first</span><span>\n</span><span>  last</span></code></pre></div><p>Done</p>');
assert.deepEqual(native, streamdown, "wrapper and rendered line boundaries must canonicalize identically");
assert.equal(native.codeBlocks[0].code, "  first\n\n  last", "code indentation and blank lines must survive");
assert.notDeepEqual(native, collect('<h2>Title</h2><pre><code class="language-js">  first\n  last</code></pre><p>Done</p>'), "missing code lines must change records");
assert.notDeepEqual(collect('<ol start="2"><li><input type="checkbox" checked>task</li></ol>'), collect('<ol start="3"><li><input type="checkbox">task</li></ol>'));
assert.notDeepEqual(collect('<table><tr><td>ab</td><td>c</td></tr></table>'), collect('<table><tr><td>a</td><td>bc</td></tr></table>'));
assert.notDeepEqual(collect('<a href="/one">same</a>'), collect('<a href="/two">same</a>'));
assert.deepEqual(collect('<a href="https://www.example.com">same</a>'), collect('<a href="https://www.example.com/">same</a>'), "absolute URL forms with the same browser destination are equivalent");
assert.deepEqual(collect('<pre><a href="https://EXAMPLE.com:443">same</a></pre>'), collect('<pre><a href="https://example.com/">same</a></pre>'), "ordered authored PRE href attributes use the same URL normalization");
assert.notDeepEqual(collect('<a href="https://example.com/one?q=1#first">same</a>'), collect('<a href="https://example.com/two?q=1#first">same</a>'), "different paths cannot normalize together");
assert.notDeepEqual(collect('<a href="https://example.com/one?q=1#first">same</a>'), collect('<a href="https://example.com/one?q=2#first">same</a>'), "different queries cannot normalize together");
assert.notDeepEqual(collect('<a href="https://example.com/one?q=1#first">same</a>'), collect('<a href="https://example.com/one?q=1#second">same</a>'), "different fragments cannot normalize together");
assert.equal(collect('<a href="../one?q=1#first">same</a>').links[0].url, "../one?q=1#first", "relative URL records cannot depend on the current page");
assert.notDeepEqual(collect('<a href="#fnref:1">same</a>'), collect('<a href="#user-content-fnref-1">same</a>'), "distinct footnote targets remain distinct");
assert.notDeepEqual(collect('<p><input type="checkbox" disabled checked></p>'), collect('<p><input type="checkbox" disabled></p>'), "checkbox state outside lists is visible semantics");
assert.notDeepEqual(collect('<p><input type="checkbox" disabled></p>'), collect('<p><input type="checkbox"></p>'), "disabled checkbox behavior is preserved");
assert.notDeepEqual(collect('<ul><li><input type="checkbox"><input type="checkbox" checked>A</li></ul>'), collect('<ul><li><input type="checkbox"><input type="checkbox">A</li></ul>'), "every checkbox inside an item is captured");
const checkboxRoot = new JSDOM('<main><p><input type="checkbox" disabled checked></p></main>').window.document.querySelector("main")!;
checkboxRoot.querySelector<HTMLInputElement>("input")!.checked = false;
assert.deepEqual(collectSemanticDom(checkboxRoot), collect('<p><input type="checkbox" disabled></p>'), "effective live checked state wins over the initial attribute");
assert.notDeepEqual(collect('<a href="/x" target="_blank">A</a>'), collect('<a href="/x" target="_self">A</a>'), "anchor navigation target is semantic");
assert.notDeepEqual(collect('<a href="/x" rel="noreferrer">A</a>'), collect('<a href="/x" rel="noopener">A</a>'), "distinct anchor rel behavior is retained");
assert.deepEqual(collect('<a href="/x" target="_BLANK" rel="NOOPENER noreferrer noopener">A</a>'), collect('<a href="/x" target="_blank" rel="noreferrer noopener">A</a>'), "equivalent target keywords and rel token sets canonicalize");
assert.notDeepEqual(collect('<a href="/x" download="one.txt">A</a>'), collect('<a href="/x" download="two.txt">A</a>'), "download filenames cannot be dropped");
assert.notDeepEqual(collect('<details open><summary>same</summary></details>'), collect('<details><summary>same</summary></details>'));
assert.equal(collect('<div>Hello</div><section>Done</section>').text, 'Hello\n\nDone');
assert.notDeepEqual(collect('<p><code>a  b</code></p>'), collect('<p><code>a b</code></p>'));
assert.notDeepEqual(collect('<p><code>a b</code></p>'), collect('<p>a b</p>'));
assert.equal(collect('<button>Authored action</button>').text, 'Authored action');
assert.notDeepEqual(collect('<b>bold</b>'), collect('<u>bold</u>'));
assert.notDeepEqual(collect('<ol reversed type="a"><li>item</li></ol>'), collect('<ol><li>item</li></ol>'));

assert.equal(collect("<pre>  a  b\n\n c </pre>").text, "  a  b\n\n c ", "authored pre whitespace is verbatim");
assert.notDeepEqual(collect("<pre>a  b</pre>"), collect("<pre>a b</pre>"));
assert.notDeepEqual(collect("<pre>a\nb</pre>"), collect("<pre>a b</pre>"));
assert.notDeepEqual(collect("<pre>A<code>x</code></pre>"), collect("<pre>B<code>x</code></pre>"), "authored PRE siblings cannot disappear behind a code child");
assert.equal(collect("<pre> A <code>x</code>\n </pre>").text, " A x\n ");
assert.notDeepEqual(collect('<pre><a href="/x">A</a></pre>'), collect('<pre><a href="/y">A</a></pre>'), "authored PRE links retain their real destination");
assert.notDeepEqual(collect('<pre><code><a href="/x">A</a></code></pre>'), collect('<pre><code><a href="/y">A</a></code></pre>'), "authored code markup cannot become cosmetic highlighting");
assert.notDeepEqual(collect("<pre>A<code>A</code></pre>"), collect("<pre><code>A</code>A</pre>"), "authored PRE code occurrence retains its literal position");
assert.deepEqual(collect("<div><p>A</p></div>"), collect("<p>A</p>"), "cosmetic block wrappers do not add ordered semantics");
assert.notDeepEqual(collect("<ol><li>A</li></ol><p>A</p>"), collect("<p>A</p><ol><li>A</li></ol>"), "ordered-list occurrence must retain its document position");
assert.notDeepEqual(collect("<h1>A</h1><p>A</p>"), collect("<p>A</p><h1>A</h1>"), "heading occurrence must retain its document position");
assert.deepEqual(collect("<ul><li><p>A</p></li></ul>"), collect("<ul><li>A</li></ul>"), "flattened list paragraph wrappers are cosmetic");
assert.notDeepEqual(collect('<p>A<a href="/x">A</a></p>'), collect('<p><a href="/x">A</a>A</p>'), "link occurrence must be associated with its position");
assert.notDeepEqual(collect("<p>A<code>A</code></p>"), collect("<p><code>A</code>A</p>"), "inline code occurrence must retain its position");
assert.notDeepEqual(collect("<p>A<em>A</em></p>"), collect("<p><em>A</em>A</p>"), "emphasis occurrence must be associated with its position");
assert.notDeepEqual(collect("<p><strong><em>A</em></strong>A</p>"), collect("<p><em><strong>A</strong></em>A</p>"), "inline nesting must survive");
assert.deepEqual(collect('<p>A<span class="visual"><a href="/x"><span>A</span></a></span></p>'), collect('<p>A<a href="/x">A</a></p>'), "styling wrappers must not change association");
assert.deepEqual(collect("<p><strong>A</strong></p>"), collect('<p><span data-streamdown="strong">A</span></p>'), "public Streamdown strong wrapper has the same semantics");

async function checkPublicStreamdownDom(): Promise<void> {
  // Streamdown exports ESM only; this existing tsx checker runs as CommonJS.
  // Exercise its real public module boundary instead of requiring a private file.
  const { Streamdown } = await import("streamdown");
  const disabledLinks = new JSDOM(renderToStaticMarkup(createElement(Streamdown, { mode: "static", linkSafety: { enabled: false }, children: "[A](/x)" }))).window.document;
  assert.equal(disabledLinks.querySelector('a[href="/x"]')?.textContent, "A", "public disabled linkSafety must render the actual anchor");
  assert.equal(disabledLinks.querySelector('button[data-streamdown="link"]'), null);
  const enabledLinks = new JSDOM(renderToStaticMarkup(createElement(Streamdown, { mode: "static", linkSafety: { enabled: true }, children: "[A](/x)" }))).window.document;
  assert.ok(enabledLinks.querySelector('button[data-streamdown="link"]'), "counterexample must exercise the public default effect");
  const footnoteDom = new JSDOM(`<main>${renderToStaticMarkup(createElement(Streamdown, { mode: "static", linkSafety: { enabled: false }, children: "Footnote[^one].\n\n[^one]: Body." }))}</main>`).window.document.querySelector("main")!;
  assert.equal(collectGeneratedFootnoteLabels(footnoteDom).length, 1, "classify the real generated sr-only label");
  assert.equal(collectSemanticDom(footnoteDom).headings.length, 0);
  assert.ok(collectSemanticDom(footnoteDom).text.includes("Body."));
  assert.ok(collectSemanticDom(footnoteDom).links.some((link) => link.url.startsWith("#user-content-fnref")), "backreferences cannot be dropped");
}
assert.equal(collect('<h2 class="sr-only" id="footnote-label">Authored heading</h2>').headings[0].text, "Authored heading");
assert.notDeepEqual(collect("<h2>Footnotes</h2><p>Body</p>"), collect("<p>Body</p>"));

const lazyCode = { id: "owned-code", type: "code", isFinalized: true, payload: { raw: "", meta: { lazyTokenization: true, lazyTokenizedUntil: 200, code: Array.from({ length: 220 }, (_, index) => `line ${index}`).join("\n") } } };
for (const key of ["htmlTree", "htmlParagraphTree"] as const) {
  const meta = { [key]: [{ kind: "element", children: [{ kind: "block", block: { id: "owned-list", type: "list", isFinalized: true, payload: { raw: "", meta: { preparedNested: { children: [{ id: "snapshot", type: "code", props: { block: lazyCode } }] } } } } }] }] };
  assert.deepEqual(collectCodeReadiness("html", meta), { allFinalized: true, pendingLazyCode: true }, `${key} block slots must recurse into prepared metadata`);
  lazyCode.payload.meta.lazyTokenizedUntil = 220;
  assert.deepEqual(collectCodeReadiness("html", meta), { allFinalized: true, pendingLazyCode: false });
  lazyCode.isFinalized = false;
  assert.equal(collectCodeReadiness("html", meta).allFinalized, false);
  lazyCode.isFinalized = true;
  lazyCode.payload.meta.lazyTokenizedUntil = 200;
}

const hash = "a".repeat(64);
const sampleStats = { count: 1, min: 10, max: 10, avg: 10, p50: 10, p95: 10 };
const evidence = {
  metadata: { profile: "parity", policy: { html: true, linkSafety: false }, fixtureHash: hash, chunkTraceHash: hash, chunkCount: 2 },
  config: { fixture: "fixture", scenario: "S6_extreme", profile: "parity", runs: 1 },
  runs: [{ semanticContent: { normalizedTextHash: hash }, cdp: { taskMs: 10 } }],
  aggregate: { semanticTextHash: hash, cdpTaskMs: sampleStats },
} satisfies ComparisonEvidence;
assert.deepEqual(comparisonInvalidity(evidence, evidence), []);
const temporary = mkdtempSync(path.join(tmpdir(), "streammdx-perf-guards-"));
try {
  const basePath = path.join(temporary, "base.json");
  const candidatePath = path.join(temporary, "candidate.json");
  writeFileSync(basePath, JSON.stringify(evidence));
  writeFileSync(candidatePath, JSON.stringify(evidence));
  const validResult = spawnSync(process.execPath, ["--import", "tsx", "scripts/perf/compare-perf-harness.ts", "--base", basePath, "--candidate", candidatePath, "--gate"], { encoding: "utf8" });
  assert.equal(validResult.status, 0, validResult.stderr);
  assert.ok(validResult.stdout.includes("CDP TaskDuration median (primary): 10.00 ms -> 10.00 ms"));
  for (const [name, candidate] of [
    ["semantic", { ...evidence, aggregate: { ...evidence.aggregate, semanticTextHash: "b".repeat(64) } }],
    ["fixture", { ...evidence, metadata: { ...evidence.metadata, fixtureHash: "b".repeat(64) } }],
    ["chunk", { ...evidence, metadata: { ...evidence.metadata, chunkTraceHash: "b".repeat(64) } }],
    ["missing", { ...evidence, metadata: undefined }],
  ] as const) {
    assert.ok(comparisonInvalidity(evidence, candidate).length > 0);
    writeFileSync(candidatePath, JSON.stringify(candidate));
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/perf/compare-perf-harness.ts", "--base", basePath, "--candidate", candidatePath, "--gate"], { encoding: "utf8" });
    assert.equal(result.status, 1, `${name} comparison must fail --gate: ${result.stderr}`);
    assert.ok(result.stdout.includes("INVALID COMPARISON"));
    assert.ok(!result.stdout.includes("No regressions") && !result.stdout.includes("[ok]"), "invalid input cannot claim a clean comparison");
    const gateResult = spawnSync(process.execPath, ["--import", "tsx", "scripts/perf/gate-perf-harness.ts", "--baseS2", basePath, "--candidateS2", candidatePath, "--baseS3", basePath, "--candidateS3", candidatePath], { encoding: "utf8" });
    assert.equal(gateResult.status, 1, `${name} multi-scenario gate must fail: ${gateResult.stderr}`);
    assert.ok(gateResult.stdout.includes("INVALID COMPARISON") && !gateResult.stdout.includes("[ok]"));
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
const scenario = { updateIntervalMs: 1, charRateCps: 20000, maxChunkChars: 7 };
const trace = createChunkTrace('abcdefghijklmnopqrstuvwxyz', scenario);
assert.equal(trace.map(chunk => chunk.text).join(''), 'abcdefghijklmnopqrstuvwxyz');
assert.deepEqual(trace.map(chunk => chunk.text.length), [7, 7, 7, 5]);
assert.deepEqual(trace, createChunkTrace('abcdefghijklmnopqrstuvwxyz', scenario), 'trace cannot depend on renderer CPU time');
checkPublicStreamdownDom().then(() => console.log("completion guard checks passed"), (error) => {
  console.error(error);
  process.exitCode = 1;
});
