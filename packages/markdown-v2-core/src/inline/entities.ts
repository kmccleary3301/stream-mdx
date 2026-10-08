/**
 * Self-contained HTML entity decoding for CommonMark compliance.
 */
import { decodeHTML5Strict } from "entities";

export function decodeEntity(raw: string): string {
  if (!raw.startsWith("&") || !raw.endsWith(";")) {
    return raw;
  }
  const inner = raw.slice(1, -1);

  // Numeric entity: &#1234; or &#x1234;
  if (inner.startsWith("#")) {
    const isHex = inner[1] === "x" || inner[1] === "X";
    const numStr = isHex ? inner.slice(2) : inner.slice(1);
    if (isHex) {
      if (numStr.length < 1 || numStr.length > 6 || !/^[0-9a-fA-F]+$/.test(numStr)) {
        return raw;
      }
    } else {
      if (numStr.length < 1 || numStr.length > 7 || !/^[0-9]+$/.test(numStr)) {
        return raw;
      }
    }
    const codePoint = isHex ? Number.parseInt(numStr, 16) : Number.parseInt(numStr, 10);
    if (!Number.isFinite(codePoint) || codePoint === 0 || codePoint > 0x10ffff) {
      return "\uFFFD";
    }
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return "\uFFFD";
    }
  }

  // HTML5 Named entity: &name;
  return decodeHTML5Strict(raw);
}
