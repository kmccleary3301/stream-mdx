/**
 * P1 Code Block Parity Verification
 * Source-authored mdast ownership and Shiki token stream verification.
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { PATCH_ROOT_ID, type Block, type TokenSpan } from "@stream-mdx/core";
import type { Code, ListItem, RootContent } from "mdast";
import { bundledLanguages, type Highlighter, type BundledLanguage, type SpecialLanguage } from "shiki";
import type { NodeRecord, RendererStore } from "@stream-mdx/react/renderer/store";
import type { MarkdownEngine } from "../../packages/markdown-v2-worker/src/engine/engine";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSpecialLanguage(lang: string): lang is SpecialLanguage {
  return lang === "text" || lang === "plaintext" || lang === "txt" || lang === "ansi";
}

function isBundledLanguage(lang: string): lang is BundledLanguage {
  return Object.hasOwn(bundledLanguages, lang);
}

export function getCodeBlockLang(meta: Record<string, unknown> | undefined): string {
  if (!meta) return "";
  const lang = meta.lang ?? meta.highlightLang ?? meta.language ?? meta.info;
  return typeof lang === "string" ? lang : "";
}

type SemanticContainer =
  | { type: "blockquote" }
  | { type: "list"; ordered: boolean }
  | { type: "listItem" };

interface AuthoredCodeOwner {
  value: string;
  lang: string;
  topology: readonly number[];
  containers: readonly SemanticContainer[];
  position: {
    startOffset: number;
    endOffset: number;
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
  };
}


function collectAuthoredCodeOwners(source: string): AuthoredCodeOwner[] {
  const owners: AuthoredCodeOwner[] = [];
  const visit = (
    node: RootContent | ListItem,
    topology: readonly number[],
    containers: readonly SemanticContainer[],
  ): void => {
    if (node.type === "code") {
      const code: Code = node;
      const position = code.position;
      if (!position || position.start.offset === undefined || position.end.offset === undefined) {
        throw new Error("Authored mdast code owner is missing source offsets");
      }
      owners.push({
        value: code.value,
        lang: code.lang ?? "",
        topology,
        containers,
        position: {
          startOffset: position.start.offset,
          endOffset: position.end.offset,
          startLine: position.start.line,
          endLine: position.end.line,
          startColumn: position.start.column,
          endColumn: position.end.column,
        },
      });
      return;
    }

    let childContainers = containers;
    if (node.type === "blockquote") {
      childContainers = [...containers, { type: "blockquote" }];
    } else if (node.type === "list") {
      childContainers = [...containers, { type: "list", ordered: node.ordered === true }];
    } else if (node.type === "listItem") {
      childContainers = [...containers, { type: "listItem" }];
    } else {
      return;
    }

    const children = node.children as ReadonlyArray<RootContent | ListItem>;
    const renderedChildren = children.filter((child) => child.type !== "definition");
    if (node.type === "listItem") {
      const firstChild = renderedChildren[0];
      const hasPrimaryInline = firstChild?.type === "paragraph" && firstChild.children.length > 0;
      let semanticIndex = 0;
      for (const child of renderedChildren) {
        if (child === firstChild && child.type === "paragraph") {
          if (hasPrimaryInline) semanticIndex += 1;
          continue;
        }
        visit(child, [...topology, semanticIndex++], childContainers);
      }
      return;
    }

    renderedChildren.forEach((child, index) => {
      visit(child, [...topology, index], childContainers);
    });
  };

  const renderedRootChildren = fromMarkdown(source).children.filter((node) => node.type !== "definition");
  renderedRootChildren.forEach((node, index) => visit(node, [index], []));
  return owners;
}
export interface AuthoredCodeFixtureExpectation {
  readonly lang?: string;
  readonly codeLines: readonly string[];
  readonly openingFenceIndent?: number;
  readonly closingFenceIndent?: number;
}

export function verifyAuthoredCodeExpectations(
  source: string,
  expectedBlocks: readonly AuthoredCodeFixtureExpectation[],
): { ok: boolean; message?: string } {
  let owners: AuthoredCodeOwner[];
  try {
    owners = collectAuthoredCodeOwners(source);
  } catch (error) {
    return { ok: false, message: `Failed to parse authored code expectations: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (owners.length !== expectedBlocks.length) {
    return {
      ok: false,
      message: `CommonMark code owner count mismatch: parsed=${owners.length} expected=${expectedBlocks.length}`,
    };
  }

  const sourceLines = source.split(/\r\n|\n|\r/);
  for (let index = 0; index < expectedBlocks.length; index += 1) {
    const owner = owners[index];
    const expected = expectedBlocks[index];
    if (expected.lang !== undefined && owner.lang !== expected.lang) {
      return {
        ok: false,
        message: `CommonMark code owner ${index} language mismatch: parsed=${JSON.stringify(owner.lang)} expected=${JSON.stringify(expected.lang)}`,
      };
    }
    const actualLines = owner.value.split("\n");
    if (actualLines.length !== expected.codeLines.length) {
      return {
        ok: false,
        message: `CommonMark code owner ${index} line count mismatch: parsed=${actualLines.length} expected=${expected.codeLines.length}`,
      };
    }
    for (let lineIndex = 0; lineIndex < expected.codeLines.length; lineIndex += 1) {
      if (actualLines[lineIndex] !== expected.codeLines[lineIndex]) {
        return {
          ok: false,
          message: `CommonMark code owner ${index} line ${lineIndex} mismatch: parsed=${JSON.stringify(actualLines[lineIndex])} expected=${JSON.stringify(expected.codeLines[lineIndex])}`,
        };
      }
    }

    const fenceIndents: readonly [string, number | undefined, number][] = [
      ["opening", expected.openingFenceIndent, owner.position.startLine],
      ["closing", expected.closingFenceIndent, owner.position.endLine],
    ];
    for (const [edge, expectedIndent, lineNumber] of fenceIndents) {
      if (expectedIndent === undefined) continue;
      const sourceLine = sourceLines[lineNumber - 1];
      const actualIndent = sourceLine?.match(/^ */)?.[0].length;
      if (actualIndent !== expectedIndent) {
        return {
          ok: false,
          message: `CommonMark code owner ${index} ${edge} fence indentation mismatch: source=${actualIndent ?? "missing"} expected=${expectedIndent} spaces`,
        };
      }
    }
  }
  return { ok: true };
}


interface MatchedCodeOwner {
  block: Block;
  authored: AuthoredCodeOwner;
}

function matchCodeOwners(
  blocks: ReadonlyArray<Block>,
  authoredOwners: ReadonlyArray<AuthoredCodeOwner>,
): { matches?: MatchedCodeOwner[]; message?: string } {
  const actualOwners = blocks.filter((block) => block.type === "code");
  if (actualOwners.length !== authoredOwners.length) {
    const missing = Math.max(0, authoredOwners.length - actualOwners.length);
    const extra = Math.max(0, actualOwners.length - authoredOwners.length);
    return {
      message: `Code owner count mismatch: authored=${authoredOwners.length} actual=${actualOwners.length} missing=${missing} extra=${extra}`,
    };
  }

  const matches: MatchedCodeOwner[] = [];
  for (let actualIndex = 0; actualIndex < actualOwners.length; actualIndex++) {
    const block = actualOwners[actualIndex];
    const range = block.payload.range;
    let authoredIndex = actualIndex;
    if (range) {
      if (!Number.isInteger(range.from) || !Number.isInteger(range.to) || range.from >= range.to) {
        return { message: `Invalid source range for code block ${block.id}: ${JSON.stringify(range)}` };
      }
      const candidates = authoredOwners.flatMap((owner, index) =>
        owner.position.startOffset >= range.from && owner.position.endOffset <= range.to ? [index] : [],
      );
      if (candidates.length !== 1) {
        return {
          message: `Code block ${block.id} range [${range.from}, ${range.to}) matches ${candidates.length} authored code owners`,
        };
      }
      authoredIndex = candidates[0];
    }

    if (authoredIndex !== actualIndex) {
      const expected = authoredOwners[actualIndex];
      const observed = authoredOwners[authoredIndex];
      return {
        message: `Code owner order mismatch at actual index ${actualIndex}: source topology [${expected.topology.join(",")}] range [${expected.position.startOffset}, ${expected.position.endOffset}) precedes actual range for source topology [${observed.topology.join(",")}]`,
      };
    }
    matches.push({ block, authored: authoredOwners[authoredIndex] });
  }
  return { matches };
}

type ActualContainerAncestry =
  | { containers: SemanticContainer[]; topology: number[] }
  | { message: string };

const NON_SEMANTIC_ANCESTOR_TYPES = {
  "__root__": true,
} satisfies Record<string, true>;

function isListItemPrimarySegment(type: string | undefined): boolean {
  return type === "list-item-text" || type === "list-item-html" || type === "list-item-mdx";
}
type ActualSemanticSiblingIndex =
  | { index: number }
  | { message: string };


function readActualSemanticSiblingIndex(
  store: RendererStore,
  parent: NodeRecord,
  childId: string,
): ActualSemanticSiblingIndex {
  const childIndex = parent.children.indexOf(childId);
  if (childIndex === -1) {
    return { message: `Renderer store parent ${parent.id} does not contain child ${childId}` };
  }
  if (parent.type !== "list-item") return { index: childIndex };

  const child = store.getNode(childId);
  if (!child) return { message: `Missing renderer store child ${childId} under list item ${parent.id}` };
  if (isListItemPrimarySegment(child.type)) return { index: 0 };

  let hasPrimaryInline =
    (Array.isArray(parent.props.inline) && parent.props.inline.length > 0)
    || Boolean(parent.props.task);
  for (const siblingId of parent.children) {
    const sibling = store.getNode(siblingId);
    if (!sibling) {
      return { message: `Missing renderer store sibling ${siblingId} under list item ${parent.id}` };
    }
    if (isListItemPrimarySegment(sibling.type)) hasPrimaryInline = true;
  }

  let structuralSiblingsBefore = 0;
  for (let index = 0; index < childIndex; index++) {
    const sibling = store.getNode(parent.children[index]);
    if (!sibling) {
      return { message: `Missing renderer store sibling ${parent.children[index]} under list item ${parent.id}` };
    }
    if (!isListItemPrimarySegment(sibling.type)) structuralSiblingsBefore += 1;
  }
  return { index: (hasPrimaryInline ? 1 : 0) + structuralSiblingsBefore };
}

function readActualContainerAncestry(store: RendererStore, blockId: string): ActualContainerAncestry {
  const codeNode = store.getNode(blockId);
  if (!codeNode) return { message: `Missing code owner ${blockId} in renderer store` };
  if (codeNode.type !== "code") {
    return { message: `Renderer store owner ${blockId} has type ${JSON.stringify(codeNode.type)}, expected code` };
  }

  const containers: SemanticContainer[] = [];
  const topology: number[] = [];
  const visited = new Set([codeNode.id]);
  let child = codeNode;
  let parentId = codeNode.parentId;
  while (parentId !== null) {
    if (visited.has(parentId)) {
      return { message: `Renderer store ancestor cycle for code owner ${blockId} at ${parentId}` };
    }
    visited.add(parentId);
    const parent = store.getNode(parentId);
    if (!parent) {
      return { message: `Missing renderer store ancestor ${parentId} for code owner ${blockId}` };
    }
    const siblingIndex = readActualSemanticSiblingIndex(store, parent, child.id);
    if ("message" in siblingIndex) return siblingIndex;
    topology.push(siblingIndex.index);
    if (parent.type === "blockquote") {
      containers.push({ type: "blockquote" });
    } else if (parent.type === "list") {
      const ordered = parent.props.ordered;
      if (typeof ordered !== "boolean") {
        return { message: `Renderer store list ancestor ${parent.id} is missing its ordered flag` };
      }
      containers.push({ type: "list", ordered });
    } else if (parent.type === "list-item") {
      containers.push({ type: "listItem" });
    } else if (!Object.hasOwn(NON_SEMANTIC_ANCESTOR_TYPES, parent.type)) {
      return {
        message: `Unexpected renderer store ancestor ${JSON.stringify(parent.type)} for code owner ${blockId}`,
      };
    }
    child = parent;
    parentId = parent.parentId;
  }
  containers.reverse();
  topology.reverse();
  return { containers, topology };
}


function sameContainerAncestry(expected: readonly SemanticContainer[], actual: readonly SemanticContainer[]): boolean {
  return expected.length === actual.length && expected.every((container, index) => {
    const observed = actual[index];
    if (!observed || container.type !== observed.type) return false;
    return container.type !== "list" || (observed.type === "list" && container.ordered === observed.ordered);
  });
}

function describeContainerAncestry(containers: readonly SemanticContainer[]): string {
  if (containers.length === 0) return "root";
  return containers.map((container) => {
    if (container.type === "list") return `${container.ordered ? "ordered" : "unordered"} list`;
    return container.type;
  }).join(" > ");
}




export interface NormalizedTokenRun {
  text: string;
  startOffset: number;
  endOffset: number;
  dark?: { fg?: string; bg?: string; fs?: number };
  light?: { fg?: string; bg?: string; fs?: number };
}

export function sameStyle(
  a?: { fg?: string; bg?: string; fs?: number },
  b?: { fg?: string; bg?: string; fs?: number },
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.fg === b.fg && a.bg === b.bg && (a.fs ?? 0) === (b.fs ?? 0);
}

export function coalesceRuns(runs: NormalizedTokenRun[]): NormalizedTokenRun[] {
  if (runs.length <= 1) return runs;
  const coalesced: NormalizedTokenRun[] = [];
  let current = { ...runs[0] };

  for (let i = 1; i < runs.length; i++) {
    const next = runs[i];
    if (sameStyle(current.dark, next.dark) && sameStyle(current.light, next.light)) {
      current.text += next.text;
      current.endOffset = next.endOffset;
    } else {
      coalesced.push(current);
      current = { ...next };
    }
  }
  coalesced.push(current);
  return coalesced;
}

export function actualSpansToRuns(spans: readonly TokenSpan[]): NormalizedTokenRun[] {
  const runs: NormalizedTokenRun[] = [];
  let offset = 0;
  for (const span of spans) {
    const text = span.t;
    if (text.length === 0) continue;
    const darkFg = span.v?.dark?.fg ?? span.s?.fg;
    const darkBg = span.v?.dark?.bg ?? span.s?.bg;
    const darkFs = (span.v?.dark?.fs ?? span.s?.fs ?? 0) > 0 ? (span.v?.dark?.fs ?? span.s?.fs) : undefined;

    const lightFg = span.v?.light?.fg ?? span.s?.fg;
    const lightBg = span.v?.light?.bg ?? span.s?.bg;
    const lightFs = (span.v?.light?.fs ?? span.s?.fs ?? 0) > 0 ? (span.v?.light?.fs ?? span.s?.fs) : undefined;

    const startOffset = offset;
    offset += text.length;
    runs.push({
      text,
      startOffset,
      endOffset: offset,
      dark: darkFg || darkBg || darkFs ? { fg: darkFg, bg: darkBg, fs: darkFs } : undefined,
      light: lightFg || lightBg || lightFs ? { fg: lightFg, bg: lightBg, fs: lightFs } : undefined,
    });
  }
  return coalesceRuns(runs);
}

export function shikiTokensToRuns(tokens: Array<{ content: string; variants?: { dark?: { color?: string; bgColor?: string; fontStyle?: number }; light?: { color?: string; bgColor?: string; fontStyle?: number } } }>): NormalizedTokenRun[] {
  const runs: NormalizedTokenRun[] = [];
  let offset = 0;
  for (const t of tokens) {
    const text = t.content;
    if (text.length === 0) continue;
    const darkVariant = t.variants?.dark;
    const lightVariant = t.variants?.light;

    const darkFg = darkVariant?.color;
    const darkBg = darkVariant?.bgColor;
    const darkFs = (darkVariant?.fontStyle ?? 0) > 0 ? darkVariant?.fontStyle : undefined;

    const lightFg = lightVariant?.color;
    const lightBg = lightVariant?.bgColor;
    const lightFs = (lightVariant?.fontStyle ?? 0) > 0 ? lightVariant?.fontStyle : undefined;

    const startOffset = offset;
    offset += text.length;
    runs.push({
      text,
      startOffset,
      endOffset: offset,
      dark: darkFg || darkBg || darkFs ? { fg: darkFg, bg: darkBg, fs: darkFs } : undefined,
      light: lightFg || lightBg || lightFs ? { fg: lightFg, bg: lightBg, fs: lightFs } : undefined,
    });
  }
  return coalesceRuns(runs);
}

export async function verifyCompletedLineTokens(
  blocks: ReadonlyArray<Block>,
  highlighter: Highlighter,
  engine: MarkdownEngine,
  store: RendererStore,
  authoredSource: string,
  expectedGeneration?: number,
): Promise<{ ok: boolean; message?: string }> {
  let authoredOwners: AuthoredCodeOwner[];
  try {
    authoredOwners = collectAuthoredCodeOwners(authoredSource);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Failed to parse authored code owners: ${message}` };
  }

  const ownerMatches = matchCodeOwners(blocks, authoredOwners);
  if (!ownerMatches.matches) return { ok: false, message: ownerMatches.message };

  for (const { block, authored } of ownerMatches.matches) {
    const ancestry = readActualContainerAncestry(store, block.id);
    if ("message" in ancestry) return { ok: false, message: ancestry.message };
    if (!sameContainerAncestry(authored.containers, ancestry.containers)) {
      return {
        ok: false,
        message: `Code container ancestry mismatch for block ${block.id} at source range [${authored.position.startOffset}, ${authored.position.endOffset}): actual=${describeContainerAncestry(ancestry.containers)} authored=${describeContainerAncestry(authored.containers)}`,
      };
    }
    if (
      authored.topology.length !== ancestry.topology.length
      || authored.topology.some((index, pathIndex) => index !== ancestry.topology[pathIndex])
    ) {
      return {
        ok: false,
        message: `Code semantic sibling topology mismatch for block ${block.id} at source range [${authored.position.startOffset}, ${authored.position.endOffset}): actual=[${ancestry.topology.join(",")}] authored=[${authored.topology.join(",")}]`,
      };
    }
    const meta = block.payload.meta;
    if (authored.lang && getCodeBlockLang(meta) !== authored.lang) {
      return {
        ok: false,
        message: `Code language mismatch for block ${block.id} at source range [${authored.position.startOffset}, ${authored.position.endOffset}): actual=${JSON.stringify(getCodeBlockLang(meta))} authored=${JSON.stringify(authored.lang)}`,
      };
    }

    const codeView = store.getCodeBlock(block.id);
    if (!codeView) {
      return { ok: false, message: `No prepared code owner state for block ${block.id}` };
    }
    if (codeView.source.codeOwnerId !== block.id) {
      return { ok: false, message: `Code source owner mismatch for block ${block.id}: ${codeView.source.codeOwnerId}` };
    }
    const ownerRecord = store.getNode(block.id);
    const isRootManagedCode = ownerRecord?.parentId === PATCH_ROOT_ID;
    if (isRootManagedCode) {
      if (expectedGeneration !== undefined && codeView.source.generation !== expectedGeneration) {
        return {
          ok: false,
          message: `Root code generation mismatch for block ${block.id}: actual=${codeView.source.generation} INITIALIZED=${expectedGeneration}`,
        };
      }
      if (store.getChildren(block.id).length !== 0) {
        return { ok: false, message: `Root code block ${block.id} has per-line NodeRecords instead of owned records` };
      }
      const { from, to } = codeView.source.sourceRange;
      if (
        from < 0 ||
        to < from ||
        to > authoredSource.length ||
        block.payload.range?.from !== from ||
        block.payload.range?.to !== to ||
        block.payload.raw !== authoredSource.slice(from, to)
      ) {
        return {
          ok: false,
          message: `Root code cold export did not preserve authored source range/text for block ${block.id}`,
        };
      }
      if (block.payload.meta?.code !== authored.value) {
        return {
          ok: false,
          message: `Root code metadata text mismatch for block ${block.id}: actual=${JSON.stringify(block.payload.meta?.code)} CommonMark=${JSON.stringify(authored.value)}`,
        };
      }
      if (codeView.info !== (typeof block.payload.meta?.info === "string" ? block.payload.meta.info : "")) {
        return { ok: false, message: `Root code info metadata mismatch for block ${block.id}` };
      }
      if (codeView.language !== (authored.lang || undefined)) {
        return {
          ok: false,
          message: `Root code language metadata mismatch for block ${block.id}: actual=${JSON.stringify(codeView.language)} CommonMark=${JSON.stringify(authored.lang || undefined)}`,
        };
      }
    }

    const targetLang = authored.lang || "text";
    let resolvedLang: BundledLanguage | SpecialLanguage;
    if (isSpecialLanguage(targetLang)) {
      resolvedLang = targetLang;
    } else if (isBundledLanguage(targetLang)) {
      const loadedLangs = highlighter.getLoadedLanguages();
      if (!loadedLangs.includes(targetLang)) {
        try {
          await highlighter.loadLanguage(targetLang);
        } catch {
          return {
            ok: false,
            message: `Failed to load bundled language '${targetLang}' for code block ${block.id}`,
          };
        }
      }
      const loaded = highlighter.getLoadedLanguages().find((language) => language === targetLang);
      if (!loaded) {
        return {
          ok: false,
          message: `Language '${targetLang}' not loaded for code block ${block.id}`,
        };
      }
      resolvedLang = targetLang;
    } else {
      return {
        ok: false,
        message: `Unsupported or unknown language '${targetLang}' for code block ${block.id}`,
      };
    }

    const authoredLines = authored.value.split("\n");
    const expectedLineCount = authoredLines.length;
    const expectedCode = authored.value;
    const expectedTokens = highlighter.codeToTokensWithThemes(expectedCode, {
      lang: resolvedLang,
      themes: { dark: "github-dark", light: "github-light" },
    });
    if (expectedTokens.length !== expectedLineCount) {
      return {
        ok: false,
        message: `Shiki line count disagrees with authored source for code block ${block.id}: generated=${expectedTokens.length} source=${expectedLineCount} (authored value lines=${authoredLines.length})`,
      };
    }

    if (codeView.source.lineCount !== expectedLineCount) {
      return {
        ok: false,
        message: `Prepared code line count mismatch for block ${block.id}: actual=${codeView.source.lineCount} expected=${expectedLineCount}`,
      };
    }
    let preparedRows = store.getCodeLines(block.id, 0, expectedLineCount);
    if (preparedRows.length !== expectedLineCount) {
      return {
        ok: false,
        message: `Bounded prepared code read returned ${preparedRows.length} rows for block ${block.id}; expected=${expectedLineCount}`,
      };
    }

    const isDeferred = Boolean(meta?.deferredTokenization || meta?.lazyTokenization);
    const hasPreparedTokens = () => preparedRows.every((line) => line.decoration !== undefined);
    if (isDeferred && !hasPreparedTokens()) {
      await engine.handle({
        type: "TOKENIZE_RANGE",
        blockId: block.id,
        startLine: 0,
        endLine: expectedLineCount,
        priority: "visible",
      });

      const startWait = Date.now();
      while (Date.now() - startWait < 1500) {
        preparedRows = store.getCodeLines(block.id, 0, expectedLineCount);
        if (preparedRows.length === expectedLineCount && hasPreparedTokens()) break;
        await delay(20);
      }
    }

    if (!hasPreparedTokens()) {
      const missing = preparedRows.findIndex((line) => line.decoration === undefined);
      return {
        ok: false,
        message: `No prepared token decoration for code block ${block.id} line ${missing}`,
      };
    }
    for (let lineIndex = 0; lineIndex < expectedLineCount; lineIndex += 1) {
      const actualLine = preparedRows[lineIndex];
      if (!actualLine) {
        return { ok: false, message: `Missing prepared code line ${lineIndex} for block ${block.id}` };
      }
      if (actualLine.text !== authoredLines[lineIndex]) {
        return {
          ok: false,
          message: `Prepared code text mismatch at line ${lineIndex}: actual=${JSON.stringify(actualLine.text)} CommonMark=${JSON.stringify(authoredLines[lineIndex])}`,
        };
      }
      const decoration = actualLine.decoration;
      if (!decoration) {
        return { ok: false, message: `Unresolved prepared token line at index ${lineIndex} for code block ${block.id}` };
      }
      if (
        decoration.lineId !== actualLine.id ||
        decoration.sourceRevision !== actualLine.sourceRevision ||
        decoration.configurationRevision !== codeView.configurationRevision
      ) {
        return {
          ok: false,
          message: `Prepared token ownership mismatch at line ${lineIndex} for code block ${block.id}`,
        };
      }
      const expectedLine = expectedTokens[lineIndex];
      const actualText = decoration.tokens.spans.map((span) => span.t).join("");
      const expectedText = expectedLine.map((token) => token.content).join("");
      if (actualText !== expectedText) {
        return {
          ok: false,
          message: `Shiki token text mismatch at line ${lineIndex}: actual=${JSON.stringify(actualText)} expected=${JSON.stringify(expectedText)}`,
        };
      }

      const actualRuns = actualSpansToRuns(decoration.tokens.spans);
      const expectedRuns = shikiTokensToRuns(expectedLine);
      if (actualRuns.length !== expectedRuns.length) {
        return {
          ok: false,
          message: `Token style run count mismatch at line ${lineIndex}: actual=${actualRuns.length} expected=${expectedRuns.length}`,
        };
      }

      for (let runIndex = 0; runIndex < actualRuns.length; runIndex++) {
        const actual = actualRuns[runIndex];
        const expected = expectedRuns[runIndex];
        if (actual.startOffset !== expected.startOffset || actual.endOffset !== expected.endOffset) {
          return {
            ok: false,
            message: `Token run offset mismatch at line ${lineIndex} run ${runIndex}: actual=[${actual.startOffset}, ${actual.endOffset}] expected=[${expected.startOffset}, ${expected.endOffset}] text=${JSON.stringify(actual.text)}`,
          };
        }
        if (actual.text !== expected.text) {
          return {
            ok: false,
            message: `Token run text mismatch at line ${lineIndex} run ${runIndex}: actual=${JSON.stringify(actual.text)} expected=${JSON.stringify(expected.text)}`,
          };
        }
        if (
          actual.dark?.fg !== expected.dark?.fg
          || actual.dark?.bg !== expected.dark?.bg
          || (actual.dark?.fs ?? 0) !== (expected.dark?.fs ?? 0)
        ) {
          return {
            ok: false,
            message: `Token dark style mismatch at line ${lineIndex} run ${runIndex} (${JSON.stringify(actual.text)}): actual=${JSON.stringify(actual.dark)} expected=${JSON.stringify(expected.dark)}`,
          };
        }
        if (
          actual.light?.fg !== expected.light?.fg
          || actual.light?.bg !== expected.light?.bg
          || (actual.light?.fs ?? 0) !== (expected.light?.fs ?? 0)
        ) {
          return {
            ok: false,
            message: `Token light style mismatch at line ${lineIndex} run ${runIndex} (${JSON.stringify(actual.text)}): actual=${JSON.stringify(actual.light)} expected=${JSON.stringify(expected.light)}`,
          };
        }
      }
    }
  }
  return { ok: true };
}
