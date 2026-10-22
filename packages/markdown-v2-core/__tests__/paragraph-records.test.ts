import assert from "node:assert";
import { freezeParagraphSpanRecord } from "../src/paragraph-records";
import type { ParagraphSpanChildSnapshot, ParagraphSpanRecord } from "../src/paragraph-records";
import type { Block, HtmlTreeNode, InlineNode } from "../src/types";

function assertDeeplyFrozen(value: unknown, path: string): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value), `${path} must be frozen`);
  for (const [key, child] of Object.entries(value)) assertDeeplyFrozen(child, `${path}.${key}`);
}

/** Freezing produces owned copies; it never freezes the caller's objects in place. */
function assertNothingFrozen(value: unknown, path: string): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(!Object.isFrozen(value), `${path} belongs to the caller and must stay mutable`);
  for (const [key, child] of Object.entries(value)) assertNothingFrozen(child, `${path}.${key}`);
}

/** Every inline kind, with every optional field present on one instance and absent on another. */
function everyInlineKind(): InlineNode[] {
  return [
    { kind: "text", text: "plain", sourceRange: { from: 0, to: 5 } },
    { kind: "strong", children: [{ kind: "em", children: [{ kind: "strike", children: [{ kind: "text", text: "nested" }] }] }] },
    { kind: "code", text: "x()" },
    { kind: "link", href: "https://a.test", title: "A", autolink: false, children: [{ kind: "text", text: "a" }] },
    { kind: "link", children: [{ kind: "text", text: "bare" }] },
    { kind: "image", src: "i.png", alt: "alt", title: "t" },
    { kind: "image", src: "bare.png" },
    { kind: "br" },
    {
      kind: "html",
      raw: "<b class=\"c\">x</b>",
      openingRaw: "<b class=\"c\">",
      closingRaw: "</b>",
      sanitized: "<b class=\"c\">x</b>",
      tagName: "b",
      isClose: false,
      isSelfClosing: false,
      attributes: { class: "c" },
      children: [{ kind: "text", text: "x" }],
    },
    { kind: "html", raw: "<br/>" },
    { kind: "mention", handle: "kyle" },
    { kind: "citation", id: "c1" },
    { kind: "math-inline", tex: "x^2" },
    { kind: "math-display", tex: "y" },
    { kind: "footnote-ref", label: "1", number: 1, occurrence: 2, defined: false },
    { kind: "footnote-ref", label: "2" },
    { kind: "plugin", name: "p", attrs: { a: "b" }, raw: "{p}", children: [{ kind: "text", text: "pc" }] },
    { kind: "plugin", name: "q", attrs: {}, raw: "{q}" },
    { kind: "trusted-mdx-inline", raw: "<X />", ownerId: "mdx-1", sourceRange: { from: 10, to: 15 } },
  ];
}

function spanRecord(overrides: Partial<ParagraphSpanRecord> = {}): ParagraphSpanRecord {
  return {
    id: "span-0",
    index: 0,
    sourceRange: { from: 0, to: 40 },
    sourceRevision: 3,
    isProvisional: true,
    nodes: everyInlineKind(),
    attemptedReferences: ["b", "a", "b"],
    ...overrides,
  };
}

function childBlock(id: string): Block {
  return {
    id,
    type: "paragraph",
    isFinalized: false,
    payload: {
      raw: "child *raw*",
      inline: [{ kind: "em", children: [{ kind: "text", text: "raw", sourceRange: { from: 6, to: 11 } }] }],
      range: { from: 0, to: 11 },
      meta: { attrs: { level: [1, { deep: "x" }] } } as Block["payload"]["meta"],
    },
  };
}

function nativeChildren(): ParagraphSpanChildSnapshot[] {
  const htmlTree: HtmlTreeNode[] = [
    { kind: "text", text: "t", inline: [{ kind: "text", text: "t", sourceRange: { from: 10, to: 11 } }], diagnostic: "d", rawSource: "t" },
    { kind: "text", text: "bare" },
    {
      kind: "element",
      tagName: "span",
      attributes: { class: "k" },
      children: [{ kind: "text", text: "inner" }],
      inlineNode: { kind: "code", text: "c" },
      paragraphRoot: false,
    },
    { kind: "element", tagName: "i", attributes: {}, children: [] },
    {
      kind: "component",
      name: "Note",
      props: { tone: "info", data: { list: [1, { nested: true }] } },
      status: "open",
      children: [
        { kind: "block", block: childBlock("html-block") },
        { kind: "block", block: { id: "bare-block", type: "paragraph", isFinalized: true, payload: { raw: "bare" } } },
      ],
      rawSource: "<Note>",
      diagnostic: "pending",
    },
    { kind: "component", name: "Bare", props: {}, status: "closed", children: [] },
  ];
  return [
    {
      id: "child-text",
      type: "paragraph-text",
      range: { from: 0, to: 10 },
      props: { inline: everyInlineKind(), meta: { counts: [1, 2], cleared: null }, lookahead: { tail: ["x"] } },
      meta: { owner: { id: "o" } },
    },
    { id: "child-html", type: "paragraph-html", range: { from: 10, to: 20 }, props: { htmlTree, htmlParagraphTree: [htmlTree[1]] } },
    { id: "child-mdx", type: "paragraph-mdx", range: { from: 20, to: 30 }, props: { block: childBlock("mdx-block") } },
    { id: "child-bare", type: "paragraph-text", range: { from: 30, to: 40 } },
  ];
}

// A frozen span record carries exactly the input content, deeply frozen and detached from the input.
{
  const input = spanRecord();
  const frozen = freezeParagraphSpanRecord(input);
  assert.deepStrictEqual(frozen, { ...spanRecord(), attemptedReferences: ["a", "b"] });
  assertDeeplyFrozen(frozen, "span");
  assertNothingFrozen(input, "input");
  const before = JSON.stringify(frozen);
  (input.nodes[1] as { children: InlineNode[] }).children.push({ kind: "br" });
  (input.nodes[8] as { attributes: Record<string, string> }).attributes.class = "mutated";
  (input.nodes[0] as { sourceRange: { from: number } }).sourceRange.from = 99;
  (input.sourceRange as { to: number }).to = 99;
  (input.attemptedReferences as string[]).push("c");
  assert.strictEqual(JSON.stringify(frozen), before, "a frozen span must not alias caller-owned input");
  assert.strictEqual(freezeParagraphSpanRecord(frozen), frozen, "a frozen span is reused");
}

// Native mixed children keep every field, including HTML trees, blocks, meta and lookahead.
{
  const input = spanRecord({ nodes: [], children: nativeChildren(), attemptedReferences: [] });
  const frozen = freezeParagraphSpanRecord(input);
  assert.deepStrictEqual(frozen, spanRecord({ nodes: [], children: nativeChildren(), attemptedReferences: [] }));
  assertDeeplyFrozen(frozen, "span with children");
  assertNothingFrozen(input, "input with children");
  const before = JSON.stringify(frozen);
  const children = input.children as ParagraphSpanChildSnapshot[];
  ((children[0].props as { meta: { counts: number[] } }).meta.counts).push(3);
  ((children[0].meta as { owner: { id: string } }).owner).id = "mutated";
  const htmlTree = (children[1].props as { htmlTree: HtmlTreeNode[] }).htmlTree;
  (htmlTree[2] as { attributes: Record<string, string> }).attributes.class = "mutated";
  ((htmlTree[4] as { props: { data: { list: unknown[] } } }).props.data.list).push("late");
  const block = (children[2].props as { block: Block }).block;
  (block.payload.range as { to: number }).to = 99;
  ((block.payload.meta as { attrs: { level: unknown[] } }).attrs.level).push("late");
  assert.strictEqual(JSON.stringify(frozen), before, "frozen children must not alias caller-owned input");
}

// Boundary values that are valid: empty span ranges, zero index and revision, children at a non-zero offset.
{
  const empty = freezeParagraphSpanRecord(spanRecord({ sourceRange: { from: 7, to: 7 }, nodes: [], sourceRevision: 0 }));
  assert.deepStrictEqual(empty.sourceRange, { from: 7, to: 7 });
  const offset = freezeParagraphSpanRecord(spanRecord({
    sourceRange: { from: 100, to: 105 },
    nodes: [],
    children: [{ id: "only", type: "paragraph-mdx", range: { from: 100, to: 105 } }],
  }));
  assert.deepStrictEqual(offset.children, [{ id: "only", type: "paragraph-mdx", range: { from: 100, to: 105 } }]);
}

// Invalid records are rejected with the documented error class.
{
  const child = (from: number, to: number, overrides: Partial<ParagraphSpanChildSnapshot> = {}): ParagraphSpanChildSnapshot => ({
    id: `c-${from}`,
    type: "paragraph-text",
    range: { from, to },
    ...overrides,
  });
  const withChildren = (children: unknown, overrides: Partial<ParagraphSpanRecord> = {}) =>
    spanRecord({ sourceRange: { from: 10, to: 20 }, nodes: [], children: children as ParagraphSpanChildSnapshot[], ...overrides });
  const cases: Array<[string, unknown, ErrorConstructor]> = [
    ["null record", null, TypeError],
    ["non-string id", spanRecord({ id: 5 as never }), TypeError],
    ["negative index", spanRecord({ index: -1 }), RangeError],
    ["fractional index", spanRecord({ index: 1.5 }), RangeError],
    ["negative sourceRevision", spanRecord({ sourceRevision: -1 }), RangeError],
    ["fractional sourceRevision", spanRecord({ sourceRevision: 0.5 }), RangeError],
    ["non-boolean isProvisional", spanRecord({ isProvisional: "yes" as never }), TypeError],
    ["missing sourceRange", spanRecord({ sourceRange: null as never }), RangeError],
    ["negative sourceRange", spanRecord({ sourceRange: { from: -1, to: 2 } }), RangeError],
    ["reversed sourceRange", spanRecord({ sourceRange: { from: 5, to: 4 } }), RangeError],
    ["fractional sourceRange.from", spanRecord({ sourceRange: { from: 0.5, to: 2 } }), RangeError],
    ["infinite sourceRange.to", spanRecord({ sourceRange: { from: 0, to: Number.POSITIVE_INFINITY } }), RangeError],
    ["non-array nodes", spanRecord({ nodes: "x" as never }), TypeError],
    ["non-array attemptedReferences", spanRecord({ attemptedReferences: "a" as never }), TypeError],
    ["non-string attemptedReferences entry", spanRecord({ attemptedReferences: [1] as never }), TypeError],
    ["empty children", withChildren([]), TypeError],
    ["non-array children", withChildren("x"), TypeError],
    ["children with inline nodes", withChildren([child(10, 20)], { nodes: [{ kind: "br" }] }), TypeError],
    ["child without string id", withChildren([child(10, 20, { id: 1 as never })]), TypeError],
    ["child of unsupported type", withChildren([child(10, 20, { type: "paragraph-code" as never })]), TypeError],
    ["child without range", withChildren([child(10, 20, { range: undefined as never })]), RangeError],
    ["child with negative range", withChildren([child(-1, 20)], { sourceRange: { from: -1, to: 20 } }), RangeError],
    ["empty child range", withChildren([child(10, 10), child(10, 20)]), RangeError],
    ["fractional child range", withChildren([child(10, 15.5), child(15.5, 20)]), RangeError],
    ["child after a gap", withChildren([child(11, 20)]), RangeError],
    ["overlapping children", withChildren([child(10, 15), child(14, 20)]), RangeError],
    ["child past the span end", withChildren([child(10, 21)]), RangeError],
    ["children short of the span end", withChildren([child(10, 19)]), RangeError],
  ];
  for (const [name, record, errorClass] of cases) {
    assert.throws(() => freezeParagraphSpanRecord(record as ParagraphSpanRecord), errorClass, name);
  }
}

console.log("paragraph records test passed");
