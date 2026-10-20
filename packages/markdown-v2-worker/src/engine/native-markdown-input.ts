import type { Input, Tree, TreeFragment } from "@lezer/common";
import type { MarkdownParser } from "@lezer/markdown";

function nativeCrLfRanges(source: Input): Array<{ from: number; to: number }> | undefined {
  let ranges: Array<{ from: number; to: number }> | undefined;
  let rangeStart = 0;
  for (let from = 0; from < source.length;) {
    const chunk = source.chunk(from);
    for (let offset = chunk.indexOf("\r"); offset >= 0; offset = chunk.indexOf("\r", offset + 1)) {
      const absolute = from + offset;
      if (absolute + 1 >= source.length) continue;
      const next = offset + 1 < chunk.length
        ? chunk.charCodeAt(offset + 1)
        : source.read(absolute + 1, absolute + 2).charCodeAt(0);
      if (next !== 10) continue;
      ranges ??= [];
      ranges.push({ from: rangeStart, to: absolute });
      rangeStart = absolute + 1;
    }
    from += chunk.length;
  }
  if (ranges) ranges.push({ from: rangeStart, to: source.length });
  return ranges;
}

class NativeStringInput implements Input {
  readonly lineChunks = false;
  readonly length: number;

  constructor(private readonly source: string) {
    this.length = source.length;
  }

  chunk(from: number): string {
    return this.source.slice(from);
  }

  read(from: number, to: number): string {
    return this.source.slice(from, to);
  }
}

/** Preserves every UTF-16 offset while presenting CRLF and lone CR as Markdown line endings. */
export class NativeMarkdownInput implements Input {
  readonly lineChunks = true;
  readonly length: number;
  private readonly source: Input;
  private readonly finalizing: boolean;

  constructor(source: Input | string, finalizing = false) {
    this.source = typeof source === "string" ? new NativeStringInput(source) : source;
    this.length = source.length;
    this.finalizing = finalizing;
  }

  /** Native range gaps remove CRLF placeholders without changing authored tree coordinates. */
  parse(parser: MarkdownParser, fragments?: readonly TreeFragment[]): Tree {
    return parser.parse(this, fragments, nativeCrLfRanges(this.source));
  }

  chunk(from: number): string {
    const start = Math.max(0, Math.min(this.length, from));
    if (start === this.length) return "";
    const raw = this.source.chunk(start);
    if (raw === "\n" || raw.length === 0) return raw;

    for (let offset = 0; offset < raw.length; offset += 1) {
      const unit = raw.charCodeAt(offset);
      if (unit === 10) return offset === 0 ? "\n" : raw.slice(0, offset);
      if (unit !== 13) continue;

      const absolute = start + offset;
      const nextUnit = offset + 1 < raw.length
        ? raw.charCodeAt(offset + 1)
        : absolute + 1 < this.length
          ? this.source.read(absolute + 1, absolute + 2).charCodeAt(0)
          : -1;
      if (nextUnit === 10 || (absolute + 1 === this.length && !this.finalizing)) {
        return this.read(start, absolute + 1);
      }
      return offset === 0 ? "\n" : raw.slice(0, offset);
    }

    return raw;
  }

  read(from: number, to: number): string {
    const start = Math.max(0, Math.min(this.length, from));
    const end = Math.max(start, Math.min(this.length, to));
    const raw = this.source.read(start, end);
    const firstCR = raw.indexOf("\r");
    if (firstCR < 0) return raw;

    const parts: string[] = [];
    let inputStart = 0;
    for (let offset = firstCR; offset < raw.length; offset += 1) {
      if (raw.charCodeAt(offset) !== 13) continue;
      parts.push(raw.slice(inputStart, offset));
      const absolute = start + offset;
      const nextUnit = offset + 1 < raw.length
        ? raw.charCodeAt(offset + 1)
        : absolute + 1 < this.length
          ? this.source.read(absolute + 1, absolute + 2).charCodeAt(0)
          : -1;
      parts.push(nextUnit === 10 || (absolute + 1 === this.length && !this.finalizing) ? " " : "\n");
      inputStart = offset + 1;
    }
    parts.push(raw.slice(inputStart));
    return parts.join("");
  }
}

