import assert from "node:assert/strict";
import { GFM, parser, Table } from "@lezer/markdown";
import type { Tree } from "@lezer/common";
import type { MarkdownConfig } from "@lezer/markdown";
import { createBlockCompatibilityExtension } from "../src/block-compatibility";

function nodeTexts(tree: Tree, source: string, name: string): string[] {
  const texts: string[] = [];
  const cursor = tree.cursor();
  do {
    if (cursor.type.name === name) texts.push(source.slice(cursor.from, cursor.to));
  } while (cursor.next());
  return texts;
}

const tableSource = "| h |\n| --- |\n--\n===\n---\n";
const nativeGfm = parser.configure([GFM, createBlockCompatibilityExtension()]);
const nativeTableTree = nativeGfm.parse(tableSource);
assert.deepEqual(nodeTexts(nativeTableTree, tableSource, "TableRow"), ["--", "==="]);
assert.deepEqual(nodeTexts(nativeTableTree, tableSource, "HorizontalRule"), ["---"]);
assert.equal(nodeTexts(nativeTableTree, tableSource, "Table").length, 1);
const paragraphToTableSource = "paragraph\n| h |\n| --- |\n--\n";
const paragraphToTableTree = nativeGfm.parse(paragraphToTableSource);
assert.deepEqual(nodeTexts(paragraphToTableTree, paragraphToTableSource, "Paragraph"), ["paragraph"]);
assert.equal(nodeTexts(paragraphToTableTree, paragraphToTableSource, "Table").length, 1);
assert.deepEqual(nodeTexts(paragraphToTableTree, paragraphToTableSource, "TableRow"), ["--"]);


const setextSource = "plain paragraph\n---\n";
const setextTree = nativeGfm.parse(setextSource);
assert.equal(nodeTexts(setextTree, setextSource, "SetextHeading2").length, 1);
assert.equal(nodeTexts(setextTree, setextSource, "HorizontalRule").length, 0);

const tableDisabledExtensions = GFM.filter((extension) => extension !== Table);
const tableDisabledNative = parser.configure(tableDisabledExtensions);
const tableDisabledGfm = parser.configure([
  tableDisabledExtensions,
  createBlockCompatibilityExtension(),
]);
const noTableSource = "| h |\n| --- |\n--\n";
const disabledTree = tableDisabledGfm.parse(noTableSource);
assert.equal(nodeTexts(disabledTree, noTableSource, "Table").length, 0);
assert.equal(disabledTree.toString(), tableDisabledNative.parse(noTableSource).toString());

const noTableInterruptionSource = "paragraph\n| h |\n| --- |\n--\n";
const disabledInterruptionTree = tableDisabledGfm.parse(noTableInterruptionSource);
assert.equal(nodeTexts(disabledInterruptionTree, noTableInterruptionSource, "Table").length, 0);
assert.equal(
  disabledInterruptionTree.toString(),
  tableDisabledNative.parse(noTableInterruptionSource).toString(),
);

const nonGfm = parser.configure(createBlockCompatibilityExtension());
const nonGfmTree = nonGfm.parse(noTableSource);
assert.equal(nodeTexts(nonGfmTree, noTableSource, "Table").length, 0);
assert.equal(nonGfmTree.toString(), parser.parse(noTableSource).toString());
const nonGfmInterruptionTree = nonGfm.parse(noTableInterruptionSource);
assert.equal(nodeTexts(nonGfmInterruptionTree, noTableInterruptionSource, "Table").length, 0);
assert.equal(nonGfmInterruptionTree.toString(), parser.parse(noTableInterruptionSource).toString());

const customLeafExtension: MarkdownConfig = {
  defineNodes: [{ name: "CustomLeafSyntax", block: true }],
  parseBlock: [{
    name: "CustomTableAwareLeaf",
    before: "Table",
    leaf(_cx, leaf) {
      if (!leaf.content.includes("|")) return null;
      return {
        nextLine(cx, line, leaf) {
          if (line.text.slice(line.pos) !== "custom: retained") return false;
          cx.addLeafElement(leaf, cx.elt("CustomLeafSyntax", leaf.start, cx.lineStart + line.text.length));
          cx.nextLine();
          return true;
        },
        finish() { return false; },
      };
    },
  }],
};
const customLeafParser = parser.configure([GFM, createBlockCompatibilityExtension(), customLeafExtension]);
const customLeafSource = "| h |\n| --- |\n--\ncustom: retained\n";
const customLeafTree = customLeafParser.parse(customLeafSource);
assert.deepEqual(nodeTexts(customLeafTree, customLeafSource, "CustomLeafSyntax"), [customLeafSource.trimEnd()]);
assert.deepEqual(nodeTexts(customLeafTree, customLeafSource, "Table"), []);

const customSetextExtension: MarkdownConfig = {
  defineNodes: [{ name: "CustomSetextSyntax", block: true }],
  parseBlock: [{
    name: "SetextHeading",
    leaf() {
      return {
        nextLine(cx, line, leaf) {
          if (line.text.slice(line.pos) !== "===") return false;
          cx.addLeafElement(leaf, cx.elt("CustomSetextSyntax", leaf.start, cx.lineStart + line.text.length));
          cx.nextLine();
          return true;
        },
        finish() { return false; },
      };
    },
  }],
};
const customSetextParser = parser.configure([GFM, createBlockCompatibilityExtension(), customSetextExtension]);
const customSetextSource = "| h |\n| --- |\n===\n";
const customSetextTree = customSetextParser.parse(customSetextSource);
assert.deepEqual(nodeTexts(customSetextTree, customSetextSource, "CustomSetextSyntax"), [customSetextSource.trimEnd()]);
assert.deepEqual(nodeTexts(customSetextTree, customSetextSource, "Table"), []);

const customHorizontalRule: MarkdownConfig = {
  parseBlock: [{
    name: "HorizontalRule",
    parse(cx, line) {
      if (line.text.slice(line.pos) !== "---!") return false;
      const from = cx.lineStart + line.pos;
      const to = cx.lineStart + line.text.length;
      cx.addElement(cx.elt("HorizontalRule", from, to));
      cx.nextLine();
      return true;
    },
    endLeaf(_cx, line) {
      return line.text.slice(line.pos) === "---!";
    },
  }],
};
const customHrParser = parser.configure([
  GFM,
  createBlockCompatibilityExtension(),
  customHorizontalRule,
]);
const customHrTableSource = "| h |\n| --- |\n---\n";
const customHrTableTree = customHrParser.parse(customHrTableSource);
assert.deepEqual(nodeTexts(customHrTableTree, customHrTableSource, "TableRow"), ["---"]);
assert.deepEqual(nodeTexts(customHrTableTree, customHrTableSource, "HorizontalRule"), []);
assert.deepEqual(nodeTexts(customHrParser.parse("---!"), "---!", "HorizontalRule"), ["---!"]);

const removedHrParser = parser.configure([
  GFM,
  createBlockCompatibilityExtension(),
  { remove: ["HorizontalRule"] },
]);
const removedHrTree = removedHrParser.parse(customHrTableSource);
assert.deepEqual(nodeTexts(removedHrTree, customHrTableSource, "TableRow"), ["---"]);
assert.deepEqual(nodeTexts(removedHrTree, customHrTableSource, "HorizontalRule"), []);
