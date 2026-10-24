import type { Input } from "@lezer/common";

declare const __STREAM_MDX_COUNTERS__: boolean | undefined;

const SOURCE_CHUNK_UNITS = 4096;
const SOURCE_LEAF_CAPACITY = 64;
const DIRECTORY_BRANCHING = 32;

/** Source-unit methods count UTF-16 units; directory and prefix methods count entries and comparisons. */
interface SourceWorkCounters {
  recordSourceUnitsRead(count: number): void;
  recordSourceUnitsMaterialized(count: number): void;
  recordSourceDirectoryEntriesCopied(count: number): void;
  recordPrefixComparisons(count: number): void;
}

interface AppendSourceDocumentOptions {
  readonly [option: string]: never;
}

interface SourceLeafPage {
  readonly chunks: (string | undefined)[];
  readonly cumulativeUnits: number[];
  count: number;
  totalUnits: number;
}

interface DirectoryPageBase {
  readonly cumulativeUnits: number[];
  childCount: number;
  totalUnits: number;
}

interface LeafDirectoryPage extends DirectoryPageBase {
  readonly kind: "leaf";
  readonly height: 0;
  readonly children: (SourceLeafPage | undefined)[];
}

interface BranchDirectoryPage extends DirectoryPageBase {
  readonly kind: "branch";
  /** Branch pages always have height greater than zero. */
  readonly height: number;
  readonly children: (DirectoryPage | undefined)[];
}

type DirectoryPage = LeafDirectoryPage | BranchDirectoryPage;

function emptyDirectoryPage(height: number): DirectoryPage {
  if (height === 0) {
    return {
      kind: "leaf",
      height: 0,
      children: new Array<SourceLeafPage | undefined>(DIRECTORY_BRANCHING),
      cumulativeUnits: new Array<number>(DIRECTORY_BRANCHING),
      childCount: 0,
      totalUnits: 0,
    };
  }
  return {
    kind: "branch",
    height,
    children: new Array<DirectoryPage | undefined>(DIRECTORY_BRANCHING),
    cumulativeUnits: new Array<number>(DIRECTORY_BRANCHING),
    childCount: 0,
    totalUnits: 0,
  };
}

function directoryCapacity(height: number): number {
  return DIRECTORY_BRANCHING ** (height + 1);
}

function directoryChildCapacity(page: DirectoryPage): number {
  return page.kind === "leaf"
    ? SOURCE_LEAF_CAPACITY
    : SOURCE_LEAF_CAPACITY * DIRECTORY_BRANCHING ** page.height;
}

function visibleDirectoryChildCount(
  page: DirectoryPage,
  baseChunkIndex: number,
  chunkCount: number,
): number {
  const remainingChunks = chunkCount - baseChunkIndex;
  if (remainingChunks <= 0) return 0;
  return Math.min(page.childCount, Math.ceil(remainingChunks / directoryChildCapacity(page)));
}

function growDirectoryRoot(root: DirectoryPage, counters?: SourceWorkCounters): BranchDirectoryPage {
  const children = new Array<DirectoryPage | undefined>(DIRECTORY_BRANCHING);
  const cumulativeUnits = new Array<number>(DIRECTORY_BRANCHING);
  children[0] = root;
  cumulativeUnits[0] = root.totalUnits;
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    counters?.recordSourceDirectoryEntriesCopied(1);
  }
  return {
    kind: "branch",
    height: root.height + 1,
    children,
    cumulativeUnits,
    childCount: 1,
    totalUnits: root.totalUnits,
  };
}

function appendSourceLeaf(
  current: SourceLeafPage | undefined,
  slot: number,
  sourceChunk: string,
): SourceLeafPage {
  const leaf = current ?? {
    chunks: new Array<string | undefined>(SOURCE_LEAF_CAPACITY),
    cumulativeUnits: new Array<number>(SOURCE_LEAF_CAPACITY),
    count: 0,
    totalUnits: 0,
  };
  const precedingUnits = slot === 0 ? 0 : (leaf.cumulativeUnits[slot - 1] ?? 0);
  leaf.chunks[slot] = sourceChunk;
  leaf.cumulativeUnits[slot] = precedingUnits + sourceChunk.length;
  leaf.count = slot + 1;
  leaf.totalUnits = leaf.cumulativeUnits[slot] ?? 0;
  return leaf;
}

function appendSourceChunk(
  currentRoot: DirectoryPage | undefined,
  chunkIndex: number,
  sourceChunk: string,
  counters?: SourceWorkCounters,
): DirectoryPage {
  const leafPageIndex = Math.floor(chunkIndex / SOURCE_LEAF_CAPACITY);
  const leafSlot = chunkIndex % SOURCE_LEAF_CAPACITY;
  let root = currentRoot ?? emptyDirectoryPage(0);
  while (leafPageIndex >= directoryCapacity(root.height)) {
    root = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? growDirectoryRoot(root, counters)
      : growDirectoryRoot(root);
  }

  return appendToDirectory(root, leafPageIndex, leafSlot, sourceChunk);
}

function appendToDirectory(
  page: DirectoryPage,
  leafPageIndex: number,
  leafSlot: number,
  sourceChunk: string,
): DirectoryPage {
  const childIndex = Math.floor(leafPageIndex / DIRECTORY_BRANCHING ** page.height) % DIRECTORY_BRANCHING;
  const precedingUnits = childIndex === 0 ? 0 : (page.cumulativeUnits[childIndex - 1] ?? 0);

  if (page.kind === "leaf") {
    const nextLeaf = appendSourceLeaf(page.children[childIndex], leafSlot, sourceChunk);
    page.children[childIndex] = nextLeaf;
    page.cumulativeUnits[childIndex] = precedingUnits + nextLeaf.totalUnits;
    page.childCount = Math.max(page.childCount, childIndex + 1);
    page.totalUnits = page.cumulativeUnits[childIndex] ?? 0;
    return page;
  }

  const childPageCapacity = DIRECTORY_BRANCHING ** page.height;

  const childOrdinal = leafPageIndex % childPageCapacity;
  const currentChild = page.children[childIndex] ?? emptyDirectoryPage(page.height - 1);
  const nextChild = appendToDirectory(currentChild, childOrdinal, leafSlot, sourceChunk);
  page.children[childIndex] = nextChild;
  page.cumulativeUnits[childIndex] = precedingUnits + nextChild.totalUnits;
  page.childCount = Math.max(page.childCount, childIndex + 1);
  page.totalUnits = page.cumulativeUnits[childIndex] ?? 0;
  return page;
}

function lowerBoundCumulativeUnits(
  cumulativeUnits: readonly number[],
  count: number,
  offset: number,
  counters?: SourceWorkCounters,
): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters?.recordPrefixComparisons(1);
    }
    if (offset < (cumulativeUnits[middle] ?? 0)) high = middle;
    else low = middle + 1;
  }
  return low;
}

function sourceChunkAt(
  root: DirectoryPage,
  sourceOffset: number,
  chunkCount: number,
  counters?: SourceWorkCounters,
): string {
  let page = root;
  let pageBaseChunkIndex = 0;
  let localOffset = sourceOffset;
  while (true) {
    const visibleChildCount = visibleDirectoryChildCount(page, pageBaseChunkIndex, chunkCount);
    const childIndex = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? lowerBoundCumulativeUnits(page.cumulativeUnits, visibleChildCount, localOffset, counters)
      : lowerBoundCumulativeUnits(page.cumulativeUnits, visibleChildCount, localOffset);
    if (childIndex >= visibleChildCount) throw new Error("Source directory child invariant violated");
    const precedingUnits = childIndex === 0 ? 0 : (page.cumulativeUnits[childIndex - 1] ?? 0);
    localOffset -= precedingUnits;

    if (page.kind === "leaf") {
      const leaf = page.children[childIndex];
      if (!leaf) throw new Error("Source directory leaf invariant violated");
      const leafBaseChunkIndex = pageBaseChunkIndex + childIndex * SOURCE_LEAF_CAPACITY;
      const visibleLeafChunkCount = Math.min(leaf.count, chunkCount - leafBaseChunkIndex);
      const chunkIndex = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? lowerBoundCumulativeUnits(leaf.cumulativeUnits, visibleLeafChunkCount, localOffset, counters)
        : lowerBoundCumulativeUnits(leaf.cumulativeUnits, visibleLeafChunkCount, localOffset);
      if (chunkIndex >= visibleLeafChunkCount) throw new Error("Source leaf chunk invariant violated");
      const precedingChunkUnits = chunkIndex === 0 ? 0 : (leaf.cumulativeUnits[chunkIndex - 1] ?? 0);
      const chunk = leaf.chunks[chunkIndex];
      if (chunk === undefined) throw new Error("Source chunk invariant violated");
      const chunkOffset = localOffset - precedingChunkUnits;
      return chunkOffset === 0 ? chunk : chunk.slice(chunkOffset);
    }

    const child = page.children[childIndex];
    if (!child) throw new Error("Source directory branch invariant violated");
    pageBaseChunkIndex += childIndex * directoryChildCapacity(page);
    page = child;
  }
}

/**
 * Lezer's Markdown reader consumes one line chunk at a time. Source storage
 * pieces are independent of line boundaries, so join only through the next LF.
 * Keep a CR before LF as authored text, matching StringInput's line scanner.
 */
function sourceLineChunkAt(
  root: DirectoryPage,
  length: number,
  chunkCount: number,
  sourceOffset: number,
  counters?: SourceWorkCounters,
): string {
  let firstPart: string | undefined;
  let parts: string[] | undefined;
  let offset = sourceOffset;
  while (offset < length) {
    const storedChunk = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? sourceChunkAt(root, offset, chunkCount, counters)
      : sourceChunkAt(root, offset, chunkCount);
    const chunkLength = Math.min(storedChunk.length, length - offset);
    const sourceChunk = chunkLength === storedChunk.length ? storedChunk : storedChunk.slice(0, chunkLength);
    const lineBreak = sourceChunk.indexOf("\n");
    const contentLength = lineBreak < 0 ? sourceChunk.length : lineBreak;
    if (contentLength > 0) {
      const part =
        contentLength === sourceChunk.length ? sourceChunk : sourceChunk.slice(0, contentLength);
      if (firstPart === undefined) {
        firstPart = part;
      } else {
        parts ??= [firstPart];
        parts.push(part);
      }
    } else if (firstPart === undefined && lineBreak === 0) {
      return sourceChunk[0] ?? "";
    }

    if (lineBreak >= 0 || offset + sourceChunk.length >= length) break;
    offset += sourceChunk.length;
  }
  return parts ? parts.join("") : firstPart ?? "";
}

function appendLeafRange(
  leaf: SourceLeafPage,
  baseOffset: number,
  baseChunkIndex: number,
  chunkCount: number,
  from: number,
  to: number,
  parts: string[],
  counters?: SourceWorkCounters,
): void {
  const visibleChunkCount = Math.min(leaf.count, Math.max(0, chunkCount - baseChunkIndex));
  if (visibleChunkCount === 0) return;
  const firstChunk = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
    ? lowerBoundCumulativeUnits(leaf.cumulativeUnits, visibleChunkCount, from - baseOffset, counters)
    : lowerBoundCumulativeUnits(leaf.cumulativeUnits, visibleChunkCount, from - baseOffset);
  for (let chunkIndex = firstChunk; chunkIndex < visibleChunkCount; chunkIndex += 1) {
    const precedingUnits = chunkIndex === 0 ? 0 : (leaf.cumulativeUnits[chunkIndex - 1] ?? 0);
    const chunkStart = baseOffset + precedingUnits;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters?.recordPrefixComparisons(1);
    }
    if (chunkStart >= to) break;

    const chunk = leaf.chunks[chunkIndex];
    if (chunk === undefined) throw new Error("Source chunk invariant violated");
    const startInChunk = Math.max(0, from - chunkStart);
    const endInChunk = Math.min(chunk.length, to - chunkStart);
    if (startInChunk < endInChunk) {
      parts.push(startInChunk === 0 && endInChunk === chunk.length ? chunk : chunk.slice(startInChunk, endInChunk));
    }
  }
}

function appendDirectoryRange(
  page: DirectoryPage,
  baseOffset: number,
  baseChunkIndex: number,
  chunkCount: number,
  from: number,
  to: number,
  parts: string[],
  counters?: SourceWorkCounters,
): void {
  const visibleChildCount = visibleDirectoryChildCount(page, baseChunkIndex, chunkCount);
  if (visibleChildCount === 0) return;
  const childCapacity = directoryChildCapacity(page);
  const firstChild = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
    ? lowerBoundCumulativeUnits(page.cumulativeUnits, visibleChildCount, from - baseOffset, counters)
    : lowerBoundCumulativeUnits(page.cumulativeUnits, visibleChildCount, from - baseOffset);
  for (let childIndex = firstChild; childIndex < visibleChildCount; childIndex += 1) {
    const precedingUnits = childIndex === 0 ? 0 : (page.cumulativeUnits[childIndex - 1] ?? 0);
    const childStart = baseOffset + precedingUnits;
    const childBaseChunkIndex = baseChunkIndex + childIndex * childCapacity;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters?.recordPrefixComparisons(1);
    }
    if (childStart >= to) break;

    if (page.kind === "leaf") {
      const leaf = page.children[childIndex];
      if (!leaf) throw new Error("Source directory leaf invariant violated");
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        appendLeafRange(leaf, childStart, childBaseChunkIndex, chunkCount, from, to, parts, counters);
      } else {
        appendLeafRange(leaf, childStart, childBaseChunkIndex, chunkCount, from, to, parts);
      }
    } else {
      const child = page.children[childIndex];
      if (!child) throw new Error("Source directory branch invariant violated");
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        appendDirectoryRange(child, childStart, childBaseChunkIndex, chunkCount, from, to, parts, counters);
      } else {
        appendDirectoryRange(child, childStart, childBaseChunkIndex, chunkCount, from, to, parts);
      }
    }
  }
}

function copyAllChunks(
  page: DirectoryPage,
  parts: string[],
  nextPart: number,
  chunkLimit: number,
): number {
  let partIndex = nextPart;
  for (let childIndex = 0; childIndex < page.childCount && partIndex < chunkLimit; childIndex += 1) {
    if (page.kind === "leaf") {
      const leaf = page.children[childIndex];
      if (!leaf) throw new Error("Source directory leaf invariant violated");
      for (let chunkIndex = 0; chunkIndex < leaf.count && partIndex < chunkLimit; chunkIndex += 1) {
        const chunk = leaf.chunks[chunkIndex];
        if (chunk === undefined) throw new Error("Source chunk invariant violated");
        parts[partIndex] = chunk;
        partIndex += 1;
      }
    } else {
      const child = page.children[childIndex];
      if (!child) throw new Error("Source directory branch invariant violated");
      partIndex = copyAllChunks(child, parts, partIndex, chunkLimit);
    }
  }
  return partIndex;
}

/**
 * An immutable Lezer reader for one append version. Its line chunks span source
 * pieces through the next LF; CR, LF, and surrogate code units remain authored
 * text and all offsets and lengths use UTF-16 units. `read` and `materialize`
 * return the exact source. Materialization is a cold O(N) join cached only by
 * this snapshot. Readers remain stable after the document appends again.
 */
export interface SourceSnapshot extends Input {
  readonly lineChunks: true;
  readonly length: number;
  materialize(): string;
}

/** A prepared append; dropping it discards it without changing the document. */
export interface StagedSourceAppend {
  readonly snapshot: SourceSnapshot;
  /** Returns false for a stale base and true after a successful, idempotent commit. */
  commit(): boolean;
}

class AppendSourceSnapshot implements SourceSnapshot {
  readonly lineChunks: true = true;
  readonly length: number;

  private readonly root: DirectoryPage | undefined;
  private readonly chunkCount: number;
  private cachedSource: string | undefined;
  private declare counters?: SourceWorkCounters;

  constructor(
    root: DirectoryPage | undefined,
    length: number,
    chunkCount: number,
    counters?: SourceWorkCounters,
  ) {
    this.root = root;
    this.length = length;
    this.chunkCount = chunkCount;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.counters = counters;
    }
  }

  chunkWithin(from: number, to: number): string {
    if (!this.root || this.length === 0) return "";
    const sourceOffset = Math.max(0, from);
    const limit = Math.min(this.length, to);
    if (sourceOffset >= limit) return "";

    let counters: SourceWorkCounters | undefined;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters = this.counters;
    }
    const result = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? sourceLineChunkAt(this.root, limit, this.chunkCount, sourceOffset, counters)
      : sourceLineChunkAt(this.root, limit, this.chunkCount, sourceOffset);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && result.length > 0) {
      counters?.recordSourceUnitsRead(result.length);
    }
    return result;
  }

  chunk(from: number): string {
    return this.chunkWithin(from, this.length);
  }

  private collectRange(from: number, to: number): string {
    if (!this.root || this.length === 0) return "";
    const start = Math.max(0, from);
    const end = Math.min(this.length, to);
    if (start >= end) return "";

    let counters: SourceWorkCounters | undefined;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters = this.counters;
    }
    const parts: string[] = [];
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      appendDirectoryRange(this.root, 0, 0, this.chunkCount, start, end, parts, counters);
    } else {
      appendDirectoryRange(this.root, 0, 0, this.chunkCount, start, end, parts);
    }
    return parts.length === 0 ? "" : parts.length === 1 ? (parts[0] ?? "") : parts.join("");
  }

  read(from: number, to: number): string {
    const result = this.collectRange(from, to);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && result.length > 0) {
      this.counters?.recordSourceUnitsRead(result.length);
    }
    return result;
  }

  materializeRange(from: number, to: number): string {
    const start = Math.max(0, from);
    const end = Math.min(this.length, to);
    if (start >= end) return "";
    if (start === 0 && end === this.length) return this.materialize();

    const result = this.collectRange(start, end);
    if (
      typeof __STREAM_MDX_COUNTERS__ !== "undefined" &&
      __STREAM_MDX_COUNTERS__ &&
      result.length > 0
    ) {
      this.counters?.recordSourceUnitsMaterialized(result.length);
    }
    return result;
  }

  materialize(): string {
    if (this.cachedSource !== undefined) return this.cachedSource;
    let counters: SourceWorkCounters | undefined;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters = this.counters;
    }
    if (!this.root) {
      this.cachedSource = "";
      return this.cachedSource;
    }

    const parts = new Array<string>(this.chunkCount);
    const nextPart = copyAllChunks(this.root, parts, 0, this.chunkCount);
    if (nextPart !== parts.length) throw new Error("Source chunk count invariant violated");
    const source = parts.join("");
    if (source.length !== this.length) throw new Error("Source length invariant violated");
    this.cachedSource = source;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters?.recordSourceUnitsMaterialized(source.length);
    }
    return source;
  }
}

class StagedAppendSnapshot implements SourceSnapshot {
  readonly lineChunks: true = true;
  readonly length: number;

  private readonly base: SourceSnapshot;
  private readonly suffix: string;
  private cachedSource: string | undefined;
  private declare counters?: SourceWorkCounters;

  constructor(base: SourceSnapshot, suffix: string, counters?: SourceWorkCounters) {
    this.base = base;
    this.suffix = suffix;
    this.length = base.length + suffix.length;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.counters = counters;
    }
  }

  private suffixLineChunk(from: number, to: number, includeLeadingLf: boolean): string {
    const start = Math.max(0, from);
    const end = Math.min(this.suffix.length, to);
    if (start >= end) return "";

    let lineBreak = -1;
    for (let index = start; index < end; index += 1) {
      if (this.suffix.charCodeAt(index) === 10) {
        lineBreak = index;
        break;
      }
    }
    if (lineBreak === start) return includeLeadingLf ? "\n" : "";
    return this.suffix.slice(start, lineBreak < 0 ? end : lineBreak);
  }

  chunkWithin(from: number, to: number): string {
    const start = Math.max(0, from);
    const limit = Math.min(this.length, to);
    if (start >= limit) return "";

    if (start >= this.base.length) {
      const suffixChunk = this.suffixLineChunk(start - this.base.length, limit - this.base.length, true);
      if (
        typeof __STREAM_MDX_COUNTERS__ !== "undefined" &&
        __STREAM_MDX_COUNTERS__ &&
        suffixChunk.length > 0
      ) {
        this.counters?.recordSourceUnitsRead(suffixChunk.length);
      }
      return suffixChunk;
    }

    const baseLimit = Math.min(this.base.length, limit);
    const baseChunk = sourceChunkWithin(this.base, start, baseLimit);
    if (
      start + baseChunk.length < baseLimit ||
      limit <= this.base.length ||
      baseChunk.charCodeAt(baseChunk.length - 1) === 10
    ) {
      return baseChunk;
    }

    const suffixChunk = this.suffixLineChunk(0, limit - this.base.length, baseChunk.length === 0);
    if (
      typeof __STREAM_MDX_COUNTERS__ !== "undefined" &&
      __STREAM_MDX_COUNTERS__ &&
      suffixChunk.length > 0
    ) {
      this.counters?.recordSourceUnitsRead(suffixChunk.length);
    }
    if (suffixChunk.length === 0) return baseChunk;
    return baseChunk.length === 0 ? suffixChunk : baseChunk + suffixChunk;
  }

  chunk(from: number): string {
    return this.chunkWithin(from, this.length);
  }

  read(from: number, to: number): string {
    const start = Math.max(0, from);
    const end = Math.min(this.length, to);
    if (start >= end) return "";

    const baseEnd = Math.min(end, this.base.length);
    const basePart = start < baseEnd ? this.base.read(start, baseEnd) : "";
    const suffixStart = Math.max(start, this.base.length);
    const suffixPart = suffixStart < end
      ? this.suffix.slice(suffixStart - this.base.length, end - this.base.length)
      : "";
    if (
      typeof __STREAM_MDX_COUNTERS__ !== "undefined" &&
      __STREAM_MDX_COUNTERS__ &&
      suffixPart.length > 0
    ) {
      this.counters?.recordSourceUnitsRead(suffixPart.length);
    }
    if (basePart.length === 0) return suffixPart;
    if (suffixPart.length === 0) return basePart;
    return basePart + suffixPart;
  }

  materializeRange(from: number, to: number): string {
    const start = Math.max(0, from);
    const end = Math.min(this.length, to);
    if (start >= end) return "";
    if (start === 0 && end === this.length) return this.materialize();

    const baseEnd = Math.min(end, this.base.length);
    const basePart = start < baseEnd
      ? materializeSourceRange(this.base, start, baseEnd)
      : "";
    const suffixStart = Math.max(start, this.base.length);
    const suffixPart = suffixStart < end
      ? this.suffix.slice(suffixStart - this.base.length, end - this.base.length)
      : "";
    if (
      typeof __STREAM_MDX_COUNTERS__ !== "undefined" &&
      __STREAM_MDX_COUNTERS__ &&
      suffixPart.length > 0
    ) {
      this.counters?.recordSourceUnitsMaterialized(suffixPart.length);
    }
    if (basePart.length === 0) return suffixPart;
    if (suffixPart.length === 0) return basePart;
    return basePart + suffixPart;
  }

  materialize(): string {
    if (this.cachedSource !== undefined) return this.cachedSource;
    const baseSource = materializeSourceRange(this.base, 0, this.base.length);
    this.cachedSource = baseSource + this.suffix;
    if (
      typeof __STREAM_MDX_COUNTERS__ !== "undefined" &&
      __STREAM_MDX_COUNTERS__ &&
      this.suffix.length > 0
    ) {
      this.counters?.recordSourceUnitsMaterialized(this.suffix.length);
    }
    return this.cachedSource;
  }
}

function sourceChunkWithin(source: SourceSnapshot, from: number, to: number): string {
  if (source instanceof AppendSourceSnapshot) return source.chunkWithin(from, to);
  if (source instanceof StagedAppendSnapshot) return source.chunkWithin(from, to);
  if (source instanceof SourceWindowSnapshot) return source.chunkWithin(from, to);

  let offset = Math.max(0, from);
  const limit = Math.min(source.length, to);
  if (offset >= limit) return "";

  let firstPart: string | undefined;
  let parts: string[] | undefined;
  while (offset < limit) {
    const readTo = Math.min(limit, offset + SOURCE_CHUNK_UNITS);
    const text = source.read(offset, readTo);
    if (text.length === 0) break;

    const lineBreak = text.indexOf("\n");
    if (firstPart === undefined && lineBreak === 0) return text[0] ?? "";
    const contentLength = lineBreak < 0 ? text.length : lineBreak;
    if (contentLength > 0) {
      const part = contentLength === text.length ? text : text.slice(0, contentLength);
      if (firstPart === undefined) {
        firstPart = part;
      } else {
        parts ??= [firstPart];
        parts.push(part);
      }
    }
    if (lineBreak >= 0 || text.length < readTo - offset) break;
    offset += text.length;
  }
  return parts ? parts.join("") : firstPart ?? "";
}

function materializeSourceRange(source: SourceSnapshot, from: number, to: number): string {
  if (
    source instanceof AppendSourceSnapshot ||
    source instanceof StagedAppendSnapshot ||
    source instanceof SourceWindowSnapshot
  ) {
    return source.materializeRange(from, to);
  }
  return source.read(from, to);
}

/** An immutable Lezer reader bounded to one half-open source range. */
class SourceWindowSnapshot implements SourceSnapshot {
  readonly lineChunks: true = true;
  readonly length: number;

  private readonly source: SourceSnapshot;
  private readonly from: number;
  private cachedSource: string | undefined;

  constructor(source: SourceSnapshot, from: number, to: number) {
    this.from = Math.max(0, Math.min(source.length, from));
    const end = Math.max(this.from, Math.min(source.length, to));
    this.length = end - this.from;
    this.source = source;
  }

  chunkWithin(from: number, to: number): string {
    const start = Math.max(0, from);
    const end = Math.min(this.length, to);
    if (start >= end) return "";
    return sourceChunkWithin(this.source, this.from + start, this.from + end);
  }

  chunk(from: number): string {
    return this.chunkWithin(from, this.length);
  }

  read(from: number, to: number): string {
    const start = Math.max(0, from);
    const end = Math.min(this.length, to);
    if (start >= end) return "";
    return this.source.read(this.from + start, this.from + end);
  }

  materializeRange(from: number, to: number): string {
    const start = Math.max(0, from);
    const end = Math.min(this.length, to);
    if (start >= end) return "";
    return materializeSourceRange(this.source, this.from + start, this.from + end);
  }

  materialize(): string {
    if (this.cachedSource !== undefined) return this.cachedSource;
    this.cachedSource = this.materializeRange(0, this.length);
    return this.cachedSource;
  }
}

/** Capture a bounded, immutable UTF-16 view without copying its source range. */
export function createSourceWindow(source: SourceSnapshot, from: number, to: number): SourceSnapshot {
  return new SourceWindowSnapshot(source, from, to);
}

/**
 * Append-indexed authored source using 4096-unit chunks, 64-entry append-only
 * leaves, and a fixed 32-way weighted directory. Appends fill new slots and
 * advance cumulative tail weights; root-height growth copies one root reference.
 * Each snapshot captures its source length and chunk count so reads, Lezer line
 * chunks, and materialization retain the same prefix after later appends.
 */
export class AppendSourceDocument {
  private root: DirectoryPage | undefined;
  private chunkCount = 0;
  private sourceLength = 0;
  private currentSnapshot: SourceSnapshot;
  private declare counters?: SourceWorkCounters;

  constructor(options?: AppendSourceDocumentOptions) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      // Private diagnostic-entry injection; counters stay out of public options.
      this.counters = (
        options as (AppendSourceDocumentOptions & { readonly counters?: SourceWorkCounters }) | undefined
      )?.counters;
      this.currentSnapshot = new AppendSourceSnapshot(undefined, 0, 0, this.counters);
    } else {
      this.currentSnapshot = new AppendSourceSnapshot(undefined, 0, 0);
    }
  }

  get length(): number {
    return this.sourceLength;
  }

  snapshot(): SourceSnapshot {
    return this.currentSnapshot;
  }

  /**
   * Prepare a view over the current canonical snapshot and this suffix only.
   * Commit appends once when that exact canonical snapshot is still current.
   */
  stageAppend(text: string): StagedSourceAppend {
    const baseSnapshot = this.snapshot();
    let counters: SourceWorkCounters | undefined;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters = this.counters;
    }

    const stagedSnapshot = text.length === 0
      ? baseSnapshot
      : typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? new StagedAppendSnapshot(baseSnapshot, text, counters)
        : new StagedAppendSnapshot(baseSnapshot, text);
    let committed = false;
    const commit = (): boolean => {
      if (committed) return true;
      if (this.currentSnapshot !== baseSnapshot) return false;
      this.append(text);
      committed = true;
      return true;
    };
    return Object.freeze({ snapshot: stagedSnapshot, commit });
  }

  append(text: string): void {
    if (text.length === 0) return;

    let counters: SourceWorkCounters | undefined;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters = this.counters;
    }

    let root = this.root;
    let chunkCount = this.chunkCount;
    for (let start = 0; start < text.length;) {
      const end = Math.min(start + SOURCE_CHUNK_UNITS, text.length);
      const sourceChunk = start === 0 && end === text.length ? text : text.slice(start, end);
      root = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? appendSourceChunk(root, chunkCount, sourceChunk, counters)
        : appendSourceChunk(root, chunkCount, sourceChunk);
      chunkCount += 1;
      start = end;
    }

    this.root = root;
    this.chunkCount = chunkCount;
    this.sourceLength += text.length;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.currentSnapshot = new AppendSourceSnapshot(this.root, this.sourceLength, this.chunkCount, this.counters);
    } else {
      this.currentSnapshot = new AppendSourceSnapshot(this.root, this.sourceLength, this.chunkCount);
    }
  }
}
