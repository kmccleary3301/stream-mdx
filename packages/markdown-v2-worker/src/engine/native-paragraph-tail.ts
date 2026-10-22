import type { SyntaxNode } from "@lezer/common";
import type { MarkdownExtension, MarkdownParser } from "@lezer/markdown";
import type { SourceSnapshot } from "@stream-mdx/core";
import { lineStartAt } from "./native-container-window";
import { NativeMarkdownInput } from "./native-markdown-input";
import { SourceRangeInput } from "./root-code-pipeline";

const nativeParagraphWindowAttestationBrand: unique symbol = Symbol("native-paragraph-window-attestation");

type ParagraphTailPhase = "open" | "closed" | "finalized" | "replaced";
export type NativeParagraphTailMode = "bounded-physical-tail" | "full-configured-context";
export type NativeParagraphTailFallbackReason = "unattested-grammar" | "native-window-mismatch";
export type NativeParagraphReadiness = "provisional" | "stable" | "finalized";

/** Exact audited native-parser features supplied by the configured-parser construction site. */
export interface NativeParagraphWindowConfiguration {
  readonly tablesEnabled: boolean;
  readonly blockCompatibility: boolean;
  readonly htmlContinuation: boolean;
  /** Footnote definitions interrupt paragraphs when the footnotes plugin is enabled. */
  readonly footnoteDefinitionInterrupts: boolean;
  /** Any caller-provided native markdown extension disables bounded-window attestation. */
  readonly customMarkdownExtensions: readonly MarkdownExtension[];
}

/** Only the audited configured-parser construction site may issue this identity/config proof. */
export interface NativeParagraphWindowAttestation {
  readonly parser: MarkdownParser;
  readonly configuration: NativeParagraphWindowConfiguration;
  readonly [nativeParagraphWindowAttestationBrand]: true;
}

export function attestNativeParagraphWindowGrammar(
  parser: MarkdownParser,
  configuration: NativeParagraphWindowConfiguration,
): NativeParagraphWindowAttestation {
  if (!configuration.blockCompatibility || !configuration.htmlContinuation
    || configuration.customMarkdownExtensions.length !== 0) {
    throw new TypeError("Native paragraph window attestation requires only the audited default block grammar");
  }
  const frozenConfiguration = Object.freeze({
    tablesEnabled: configuration.tablesEnabled,
    blockCompatibility: configuration.blockCompatibility,
    htmlContinuation: configuration.htmlContinuation,
    footnoteDefinitionInterrupts: configuration.footnoteDefinitionInterrupts,
    customMarkdownExtensions: Object.freeze(Array.from(configuration.customMarkdownExtensions)),
  });
  return Object.freeze({
    parser,
    configuration: frozenConfiguration,
    [nativeParagraphWindowAttestationBrand]: true as const,
  });
}

export interface NativeParagraphRootCandidate {
  readonly node: SyntaxNode;
  readonly sourceOffset: number;
  readonly readiness: NativeParagraphReadiness;
  /**
   * Source line start of the root. A root parse resumes here, never at `node.from`: Lezer starts indented code at
   * its content column, and reparsing from there reads the code text as a paragraph.
   */
  readonly lineFrom: number;
}

export interface NativeParagraphTailState {
  readonly ownerStart: number;
  readonly ownerEnd: number;
  readonly processedTo: number;
  readonly phase: ParagraphTailPhase;
  readonly mode: NativeParagraphTailMode;
  readonly followingRootNodes: readonly NativeParagraphRootCandidate[];
}

export interface NativeParagraphTailChange {
  readonly ownerStart: number;
  /** End of the paragraph node decided by the actual configured native parser. */
  readonly ownerEnd: number;
  readonly processedTo: number;
  readonly mode: NativeParagraphTailMode;
  readonly followingRootNodes: readonly NativeParagraphRootCandidate[];
  readonly closure: "open" | "following-root" | "finalized" | "owner-replaced";
  readonly rootResumeFrom?: number;
  readonly fallbackReason?: NativeParagraphTailFallbackReason;
  readonly replacementNode?: SyntaxNode;
  readonly replacementSourceOffset?: number;
  readonly requiresOwnerReplacement: boolean;
}

interface ParsedParagraphWindow {
  readonly ownerNode?: SyntaxNode;
  readonly replacementNode?: SyntaxNode;
  readonly replacementOffset?: number;
  readonly following: readonly NativeParagraphRootCandidate[];
  readonly ownerEnd: number;
}

function lastPhysicalLineStart(source: SourceSnapshot, from: number, to: number): number {
  const raw = source.read(from, to);
  let scanEnd = raw.length;
  if (scanEnd > 0 && raw[scanEnd - 1] === "\n") {
    scanEnd -= 1;
    if (scanEnd > 0 && raw[scanEnd - 1] === "\r") scanEnd -= 1;
  } else if (scanEnd > 0 && raw[scanEnd - 1] === "\r") {
    scanEnd -= 1;
  }
  const lf = raw.lastIndexOf("\n", scanEnd - 1);
  const cr = raw.lastIndexOf("\r", scanEnd - 1);
  const separator = Math.max(lf, cr);
  if (separator < 0) return from;
  return from + separator + 1;
}

function lineCoordinatesAtEnd(
  source: SourceSnapshot,
  from: number,
  to: number,
): { readonly currentLineStart: number; readonly lastLineStart: number; readonly pendingCR: boolean } {
  const raw = source.read(from, to);
  let currentLineStart = from;
  let lastLineStart = from;
  let pendingCR = false;
  for (let index = 0; index < raw.length;) {
    const unit = raw[index];
    if (unit === "\r") {
      if (index + 1 === raw.length) {
        pendingCR = true;
        break;
      }
      lastLineStart = currentLineStart;
      currentLineStart = from + index + (raw[index + 1] === "\n" ? 2 : 1);
      index += raw[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (unit === "\n") {
      lastLineStart = currentLineStart;
      currentLineStart = from + index + 1;
    }
    index += 1;
  }
  return { currentLineStart, lastLineStart, pendingCR };
}

function advanceLineCoordinates(
  currentLineStart: number,
  lastLineStart: number,
  previousPendingCR: boolean,
  from: number,
  appendedText: string,
): { readonly currentLineStart: number; readonly lastLineStart: number; readonly pendingCR: boolean } {
  let current = currentLineStart;
  let last = lastLineStart;
  let pendingCR = previousPendingCR;
  let index = 0;

  if (pendingCR) {
    last = current;
    current = from;
    pendingCR = false;
    if (appendedText[0] === "\n") {
      current = from + 1;
      index = 1;
    }
  }

  while (index < appendedText.length) {
    const unit = appendedText[index];
    if (unit === "\r") {
      if (index + 1 === appendedText.length) {
        pendingCR = true;
        break;
      }
      last = current;
      const crlf = appendedText[index + 1] === "\n";
      current = from + index + (crlf ? 2 : 1);
      index += crlf ? 2 : 1;
      continue;
    }
    if (unit === "\n") {
      last = current;
      current = from + index + 1;
    }
    index += 1;
  }
  return { currentLineStart: current, lastLineStart: last, pendingCR };
}

function hasTerminalNativeLineEnding(
  source: SourceSnapshot,
  sourceOffset: number,
  inputLength: number,
): boolean {
  const inputEnd = sourceOffset + inputLength;
  return inputLength > 0
    && inputEnd <= source.length
    && source.read(inputEnd - 1, inputEnd) === "\n";
}
function hasOnlyOptionalFinalLineEnding(
  source: SourceSnapshot,
  sourceEnd: number,
  inputEnd: number,
): boolean {
  const trailingLength = inputEnd - sourceEnd;
  if (trailingLength === 0) return true;
  if (trailingLength === 1) {
    const unit = source.read(sourceEnd, inputEnd);
    return unit === "\n" || unit === "\r";
  }
  return trailingLength === 2 && source.read(sourceEnd, inputEnd) === "\r\n";
}
/** Reads at most eight source units to prove a blank line before a parser-proven native root. */
function hasNativeBlankLineBeforeRoot(
  source: SourceSnapshot,
  ownerEnd: number,
  previousSourceEnd: number,
  rootStart: number,
): boolean {
  let boundaryStart = ownerEnd;
  if (ownerEnd === previousSourceEnd && previousSourceEnd > 0) {
    const last = source.read(previousSourceEnd - 1, previousSourceEnd);
    if (last === "\n") {
      boundaryStart = previousSourceEnd - 1;
      if (boundaryStart > 0 && source.read(boundaryStart - 1, boundaryStart) === "\r") boundaryStart -= 1;
    } else if (last === "\r") {
      boundaryStart = previousSourceEnd - 1;
    }
  }
  if (rootStart - boundaryStart < 2) return false;
  const prefix = source.read(boundaryStart, Math.min(rootStart, boundaryStart + 8));
  let lineBreaks = 0;
  for (let index = 0; index < prefix.length; index += 1) {
    const unit = prefix[index];
    if (unit === "\r") {
      lineBreaks += 1;
      if (prefix[index + 1] === "\n") index += 1;
    } else if (unit === "\n") {
      lineBreaks += 1;
    } else if ((unit === " " || unit === "\t") && lineBreaks === 1) {
      continue;
    } else {
      return false;
    }
    if (lineBreaks === 2) return true;
  }
  return false;
}


function followingRoots(
  first: SyntaxNode | null,
  source: SourceSnapshot,
  sourceOffset: number,
  inputLength: number,
  finalizing: boolean,
): NativeParagraphRootCandidate[] {
  const result: NativeParagraphRootCandidate[] = [];
  const terminalLineEnding = !finalizing && hasTerminalNativeLineEnding(source, sourceOffset, inputLength);
  for (let node = first; node; node = node.nextSibling) {
    const terminalReference = node.type.name === "LinkReference"
      && node.to < inputLength
      && terminalLineEnding;
    result.push({
      node,
      sourceOffset,
      readiness: finalizing ? "finalized" : node.to < inputLength - 1 || terminalReference ? "stable" : "provisional",
      lineFrom: lineStartAt(source, sourceOffset + node.from, sourceOffset),
    });
  }
  return result;
}

function rootAtOwnerStart(
  topNode: SyntaxNode,
  ownerStart: number,
  ownerEnd: number,
): { readonly owner?: SyntaxNode; readonly replacement?: SyntaxNode; readonly following: readonly SyntaxNode[] } {
  let node = topNode.firstChild;
  while (node && node.from < ownerStart && node.to < ownerStart) node = node.nextSibling;
  if (!node || node.from > ownerStart) return { following: [] };
  if (node.from > ownerStart || node.to < ownerStart) return { following: [] };
  const following: SyntaxNode[] = [];
  for (let next = node.nextSibling; next; next = next.nextSibling) following.push(next);
  return node.type.name === "Paragraph" && node.from === ownerStart && node.to >= ownerEnd
    ? { owner: node, following }
    : { replacement: node, following };
}

function candidatesAfter(
  first: SyntaxNode | null,
  source: SourceSnapshot,
  sourceOffset: number,
  inputLength: number,
  finalizing: boolean,
): readonly NativeParagraphRootCandidate[] {
  return followingRoots(first, source, sourceOffset, inputLength, finalizing);
}

function inspectWindow(
  tree: { readonly topNode: SyntaxNode },
  source: SourceSnapshot,
  sourceOffset: number,
  previousOwnerEnd: number,
  inputLength: number,
  finalizing: boolean,
): ParsedParagraphWindow {
  const first = tree.topNode.firstChild;
  if (!first) return { following: [], ownerEnd: previousOwnerEnd };
  const firstStart = sourceOffset + first.from;
  if (first.type.name === "Paragraph" && firstStart <= previousOwnerEnd) {
    return {
      ownerNode: first,
      following: candidatesAfter(first.nextSibling, source, sourceOffset, inputLength, finalizing),
      ownerEnd: sourceOffset + first.to,
    };
  }
  const candidateOffset = sourceOffset;
  const following = candidatesAfter(first, source, candidateOffset, inputLength, finalizing);
  if (firstStart <= previousOwnerEnd) {
    return {
      replacementNode: first,
      replacementOffset: sourceOffset,
      following,
      ownerEnd: sourceOffset + first.to,
    };
  }
  return { following, ownerEnd: previousOwnerEnd };
}

/**
 * Native root-paragraph continuation. The trusted path reparses only the prior physical context
 * line plus newly admitted bytes; Setext/table/type changes return whole-owner recovery instead of
 * making an irreversible source classification. Unattested grammars retain exact full-source input.
 */
export class NativeParagraphTailParser {
  private readonly parser: MarkdownParser;
  private readonly ownerStart: number;
  private attested: boolean;
  private sourceLength: number;
  private ownerEnd: number;
  private currentLineStart: number;
  private lastLineStart: number;
  private pendingCR: boolean;
  private phase: ParagraphTailPhase = "open";
  private fallbackReason: NativeParagraphTailFallbackReason | undefined;
  private following: readonly NativeParagraphRootCandidate[] = [];
  private finalizedAppendCandidate = false;
  private replacementNode: SyntaxNode | undefined;
  private replacementSourceOffset: number | undefined;

  private constructor(
    parser: MarkdownParser,
    source: SourceSnapshot,
    nativeParagraph: SyntaxNode,
    sourceOffset: number,
    attestation?: NativeParagraphWindowAttestation,
  ) {
    this.parser = parser;
    this.ownerStart = sourceOffset + nativeParagraph.from;
    this.ownerEnd = sourceOffset + nativeParagraph.to;
    this.sourceLength = source.length;
    this.attested = attestation !== undefined;
    const following = followingRoots(nativeParagraph.nextSibling, source, sourceOffset, source.length - sourceOffset, false);
    // Same coordinates as `append` keeps: the line being typed and the one before it, so the first append's window
    // still holds a table header or Setext text line above the line it completes.
    const coordinates = lineCoordinatesAtEnd(source, this.ownerStart, following.length > 0 ? this.ownerEnd : source.length);
    this.currentLineStart = coordinates.currentLineStart;
    this.lastLineStart = coordinates.lastLineStart;
    this.pendingCR = coordinates.pendingCR;
    this.following = following;
    this.finalizedAppendCandidate = following.length === 0
      && hasOnlyOptionalFinalLineEnding(source, this.ownerEnd, this.sourceLength);
    // Sibling roots close this source range even when the following root is provisional.
    if (following.length > 0) this.phase = "closed";
  }

  static admit(
    parser: MarkdownParser,
    source: SourceSnapshot,
    nativeParagraph: SyntaxNode,
    sourceOffset = 0,
    attestation?: NativeParagraphWindowAttestation,
  ): NativeParagraphTailParser {
    if (nativeParagraph.type.name !== "Paragraph") throw new TypeError("NativeParagraphTailParser admits only native Paragraph nodes");
    if (attestation && attestation.parser !== parser) {
      throw new TypeError("Native paragraph grammar attestation belongs to a different MarkdownParser");
    }
    if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0) {
      throw new RangeError("Native paragraph sourceOffset must be a non-negative safe integer");
    }
    const parent = nativeParagraph.parent;
    if (!parent || parent.type.name !== "Document" || parent.parent) {
      throw new TypeError("NativeParagraphTailParser admits only Paragraph nodes directly under Document");
    }
    const from = sourceOffset + nativeParagraph.from;
    const to = sourceOffset + nativeParagraph.to;
    if (from < 0 || to < from || to > source.length) {
      throw new RangeError("Native paragraph source range is outside the authored snapshot");
    }
    return new NativeParagraphTailParser(parser, source, nativeParagraph, sourceOffset, attestation);
  }

  get state(): NativeParagraphTailState {
    return {
      ownerStart: this.ownerStart,
      ownerEnd: this.ownerEnd,
      processedTo: this.sourceLength,
      phase: this.phase,
      mode: this.attested ? "bounded-physical-tail" : "full-configured-context",
      followingRootNodes: this.following,
    };
  }
  get canAppendAfterFinalize(): boolean {
    return this.phase === "finalized" && this.finalizedAppendCandidate;
  }


  append(source: SourceSnapshot, appendedText: string): NativeParagraphTailChange {
    if (source.length < this.sourceLength || appendedText.length !== source.length - this.sourceLength) {
      throw new RangeError("Native paragraph source input must be an append-only exact suffix");
    }
    if (this.phase !== "open") throw new Error(`Cannot append to a ${this.phase} native paragraph tail`);
    if (appendedText.length === 0) return this.emptyChange();
    if (!this.attested) return this.parseFullConfiguredContext(source, false, "unattested-grammar");

    const windowFrom = this.lastLineStart;
    const window = new NativeMarkdownInput(new SourceRangeInput(source, windowFrom));
    const tree = window.parse(this.parser);
    const parsed = inspectWindow(tree, source, windowFrom, this.ownerEnd, window.length, false);
    if (!parsed.ownerNode && !parsed.replacementNode && parsed.following.length === 0 && window.length > 0) {
      return this.parseFullConfiguredContext(source, false, "native-window-mismatch");
    }

    if (parsed.replacementNode) {
      this.phase = "replaced";
      this.sourceLength = source.length;
      this.fallbackReason = "native-window-mismatch";
      this.replacementNode = parsed.replacementNode;
      this.replacementSourceOffset = parsed.replacementOffset;
      this.following = parsed.following;
      return this.change("bounded-physical-tail", true, parsed.ownerEnd);
    }

    if (parsed.ownerNode) this.ownerEnd = parsed.ownerEnd;
    const nextCoordinates = advanceLineCoordinates(
      this.currentLineStart,
      this.lastLineStart,
      this.pendingCR,
      this.sourceLength,
      appendedText,
    );
    this.currentLineStart = nextCoordinates.currentLineStart;
    this.lastLineStart = nextCoordinates.lastLineStart;
    this.pendingCR = nextCoordinates.pendingCR;
    this.sourceLength = source.length;
    this.following = parsed.following;
    if (this.following.length > 0) this.phase = "closed";
    return this.change("bounded-physical-tail", false, this.ownerEnd);
  }
  // A suffix root is reusable only after a blank line; continuations and context-sensitive
  // replacements stay on the previous-window parser.

  private closeOnAppendedNativeRoot(
    source: SourceSnapshot,
    appendedText: string,
  ): NativeParagraphTailChange | undefined {
    if (
      !this.attested
      || source.length < this.sourceLength
      || appendedText.length !== source.length - this.sourceLength
      || appendedText.length === 0
    ) return undefined;

    const sourceOffset = this.sourceLength;
    const input = new SourceRangeInput(source, sourceOffset);
    const tree = new NativeMarkdownInput(input).parse(this.parser);
    const parsed = inspectWindow(tree, source, sourceOffset, this.ownerEnd, input.length, false);
    if (parsed.ownerNode || parsed.replacementNode) return undefined;
    const firstFollowing = parsed.following[0];
    if (!firstFollowing) return undefined;
    const rootStart = firstFollowing.sourceOffset + firstFollowing.node.from;
    if (!hasNativeBlankLineBeforeRoot(source, this.ownerEnd, this.sourceLength, rootStart)) return undefined;

    this.phase = "closed";
    this.finalizedAppendCandidate = false;
    this.sourceLength = source.length;
    this.following = parsed.following;
    return this.change("bounded-physical-tail", false, this.ownerEnd);
  }

  appendAfterFinalize(source: SourceSnapshot, appendedText: string): NativeParagraphTailChange {
    if (!this.canAppendAfterFinalize) {
      throw new Error("Only a terminal finalized native paragraph can probe an appended suffix");
    }
    const nativeBoundary = this.closeOnAppendedNativeRoot(source, appendedText);
    if (nativeBoundary) return nativeBoundary;
    const previousOwnerEnd = this.ownerEnd;
    this.phase = "open";
    this.finalizedAppendCandidate = false;
    const change = this.append(source, appendedText);
    if (!change.requiresOwnerReplacement && this.ownerEnd === previousOwnerEnd && this.following.length === 0) {
      this.phase = "finalized";
      this.finalizedAppendCandidate = this.attested
        && hasOnlyOptionalFinalLineEnding(source, this.ownerEnd, this.sourceLength);
      return this.change(change.mode, false, this.ownerEnd);
    }
    return change;
  }


  finalize(source: SourceSnapshot): NativeParagraphTailChange {
    if (this.phase === "closed" && source.length >= this.sourceLength) {
      this.phase = "finalized";
      return this.change(this.attested ? "bounded-physical-tail" : "full-configured-context", false, this.ownerEnd);
    }
    if (source.length !== this.sourceLength) {
      throw new RangeError("Append the latest source snapshot before finalizing a native paragraph tail");
    }
    if (this.phase === "replaced") return this.change("full-configured-context", true, this.ownerEnd);
    if (!this.attested) return this.parseFullConfiguredContext(source, true, "unattested-grammar");

    const windowFrom = this.lastLineStart;
    const input = new NativeMarkdownInput(new SourceRangeInput(source, windowFrom));
    const tree = input.parse(this.parser);
    const parsed = inspectWindow(tree, source, windowFrom, this.ownerEnd, input.length, true);
    if (parsed.replacementNode) {
      this.phase = "replaced";
      this.replacementNode = parsed.replacementNode;
      this.replacementSourceOffset = parsed.replacementOffset;
      this.following = parsed.following;
      return this.change("bounded-physical-tail", true, parsed.ownerEnd);
    }
    if (parsed.ownerNode) this.ownerEnd = parsed.ownerEnd;
    this.following = parsed.following;
    this.phase = "finalized";
    this.finalizedAppendCandidate = this.attested
      && this.following.length === 0
      && hasOnlyOptionalFinalLineEnding(source, this.ownerEnd, this.sourceLength);
    return this.change("bounded-physical-tail", false, this.ownerEnd);
  }

  private parseFullConfiguredContext(
    source: SourceSnapshot,
    finalizing: boolean,
    reason: NativeParagraphTailFallbackReason,
  ): NativeParagraphTailChange {
    const input = new NativeMarkdownInput(source);
    const tree = input.parse(this.parser);
    const located = rootAtOwnerStart(tree.topNode, this.ownerStart, this.ownerEnd);
    if (!located.owner) {
      this.phase = "replaced";
      this.sourceLength = source.length;
      this.fallbackReason = reason;
      this.replacementNode = located.replacement;
      this.replacementSourceOffset = 0;
      this.following = candidatesAfter(located.following[0] ?? null, source, 0, source.length, finalizing);
      return this.change("full-configured-context", true, this.ownerEnd);
    }

    this.ownerEnd = located.owner.to;
    this.following = candidatesAfter(located.following[0] ?? null, source, 0, source.length, finalizing);
    this.sourceLength = source.length;
    this.fallbackReason = reason;
    if (finalizing) this.phase = "finalized";
    else if (this.following[0]?.readiness === "stable") this.phase = "closed";
    return this.change("full-configured-context", false, this.ownerEnd);
  }

  private emptyChange(): NativeParagraphTailChange {
    return this.change(
      this.attested ? "bounded-physical-tail" : "full-configured-context",
      this.phase === "replaced",
      this.ownerEnd,
    );
  }

  private change(mode: NativeParagraphTailMode, requiresOwnerReplacement: boolean, ownerEnd: number): NativeParagraphTailChange {
    const closure = this.phase === "finalized"
      ? "finalized"
      : this.phase === "replaced"
        ? "owner-replaced"
        : this.phase === "closed"
          ? "following-root"
          : "open";
    const firstFollowing = this.following[0];
    const resumeFollowingRoot = closure === "following-root"
      ? firstFollowing
      : closure === "open"
        ? this.following.find((root) => root.readiness === "provisional")
        : undefined;
    const rootResumeFrom = resumeFollowingRoot?.lineFrom;
    return {
      ownerStart: this.ownerStart,
      ownerEnd,
      processedTo: this.sourceLength,
      mode,
      followingRootNodes: this.following,
      closure,
      ...(rootResumeFrom === undefined ? {} : { rootResumeFrom }),
      ...(this.fallbackReason ? { fallbackReason: this.fallbackReason } : {}),
      ...(this.replacementNode ? { replacementNode: this.replacementNode } : {}),
      ...(this.replacementSourceOffset === undefined ? {} : { replacementSourceOffset: this.replacementSourceOffset }),
      requiresOwnerReplacement,
    };
  }
}
