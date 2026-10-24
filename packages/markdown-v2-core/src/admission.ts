/**
 * Strict Restricted Prop Lexer & Admission Validation
 *
 * Implements strict prop parsing for restricted MDX components:
 * - Quoted strings: "...", '...' with literal text and HTML entity decoding
 * - Boolean shorthand: prop
 * - Brace strict JSON only: prop={42}, prop={true}, prop={{"key": "value"}}
 * - Strictly rejects executable expressions, imports/exports, spreads,
 *   duplicate props, callback/ref injection, dangerouslySetInnerHTML,
 *   and unsafe object keys (__proto__, constructor, prototype) recursively.
 * - Distinguishes incomplete vs invalid tag headers.
 * - Preserves exact authored source.
 * - Shared admission function for tags and future P7 colon containers.
 */
import { decodeHTML5Strict } from "entities";

export interface RestrictedComponentDescriptor {
  readonly name: string;
  readonly renderWhen?: "open" | "closed"; // default "open"
}

export type RestrictedTagParseResult =
  | {
      readonly ok: true;
      readonly kind: "open" | "self-closing";
      readonly tagName: string;
      readonly props: Readonly<Record<string, unknown>>;
      readonly raw: string;
    }
  | {
      readonly ok: true;
      readonly kind: "close";
      readonly tagName: string;
      readonly raw: string;
    }
  | {
      readonly ok: false;
      readonly tagName?: string;
      readonly error: string;
      readonly raw: string;
      readonly incomplete?: boolean;
    };

export interface RestrictedAttributesParseResult {
  readonly ok: boolean;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly error?: string;
  readonly raw?: string;
  readonly incomplete?: boolean;
  readonly consumedLength: number;
}

const RESERVED_PROPS: Record<string, true> = {
  ref: true,
  key: true,
  dangerouslysetinnerhtml: true,
};

const UNSAFE_OBJECT_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function hasUnsafeObjectKeys(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some(hasUnsafeObjectKeys);
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) {
      return true;
    }
    if (hasUnsafeObjectKeys((value as Record<string, unknown>)[key])) {
      return true;
    }
  }
  return false;
}

function deepFreezeValue(value: object, visited: WeakSet<object>): void {
  if (visited.has(value)) return;
  visited.add(value);
  if (!Object.isFrozen(value)) Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    try {
      const child = Reflect.get(value, key);
      if (child !== null && typeof child === "object") {
        deepFreezeValue(child, visited);
      }
    } catch {
      // Ignore accessor or frozen property access issues
    }
  }
}

/** Freezes admitted data recursively, including descendants of frozen parents. */
export function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  deepFreezeValue(obj, new WeakSet<object>());
  return obj;
}

export function isRestrictedComponentName(name: string): boolean {
  if (!name || name.length === 0) return false;
  const first = name.charAt(0);
  return first >= "A" && first <= "Z" && /^[A-Z][\w-]*$/.test(name);
}

/**
 * Parses literal quoted text with the native HTML entity decoder. Backslash
 * escape syntax belongs only to brace-delimited strict JSON.
 */
function parseQuotedString(
  input: string,
  quote: string,
  start: number
): { value: string; nextIndex: number } | { error: string; incomplete: boolean } {
  const endIndex = input.indexOf(quote, start);
  if (endIndex < 0) {
    return { error: "Unterminated quoted string", incomplete: true };
  }
  return {
    value: decodeHTML5Strict(input.slice(start, endIndex)),
    nextIndex: endIndex + 1,
  };
}

/**
 * Shared admission function for parsing restricted props/attributes.
 * Shared between restricted JSX tags and future P7 colon containers.
 *
 * @param input Raw attribute string slice
 * @param startIndex Starting offset
 * @param stopChar Optional character that stops attribute parsing (e.g. ">" or "}")
 */
export function parseRestrictedAttributes(
  input: string,
  startIndex = 0,
  stopChar?: string
): RestrictedAttributesParseResult {
  let index = startIndex;
  const len = input.length;
  const props: Record<string, unknown> = Object.create(null);
  const seenProps = new Set<string>();

  while (index < len) {
    // Skip whitespace
    while (index < len && /\s/.test(input[index])) {
      index++;
    }
    if (index >= len) break;

    // Check stop character (e.g. ">" or "/>" or "}")
    if (stopChar && input[index] === stopChar) {
      break;
    }
    if (stopChar === ">" && input.startsWith("/>", index)) {
      break;
    }

    // Check for spread `{...props}` -> REJECT
    if (input[index] === "{") {
      return {
        ok: false,
        error: "Spreads and expressions are forbidden in restricted components",
        incomplete: false,
        consumedLength: index - startIndex,
      };
    }

    // Attribute name: starts with ASCII letter or underscore
    const attrNameMatch = /^[a-zA-Z_][\w-]*/.exec(input.slice(index));
    if (!attrNameMatch) {
      return {
        ok: false,
        error: `Invalid attribute name at index ${index}`,
        incomplete: false,
        consumedLength: index - startIndex,
      };
    }

    const attrName = attrNameMatch[0];
    index += attrName.length;

    // Top-level unsafe key rejection (proto pollution defense before any assignment)
    if (UNSAFE_OBJECT_KEYS.has(attrName)) {
      return {
        ok: false,
        error: `Unsafe attribute name rejected: ${attrName}`,
        incomplete: false,
        consumedLength: index - startIndex,
      };
    }

    // Disallow duplicate props
    if (seenProps.has(attrName)) {
      return {
        ok: false,
        error: `Duplicate attribute: ${attrName}`,
        incomplete: false,
        consumedLength: index - startIndex,
      };
    }
    seenProps.add(attrName);

    // Reject reserved props (ref, key, on*, dangerouslySetInnerHTML)
    const lowerAttr = attrName.toLowerCase();
    if (lowerAttr.startsWith("on") || RESERVED_PROPS[lowerAttr]) {
      return {
        ok: false,
        error: `Forbidden attribute name: ${attrName}`,
        incomplete: false,
        consumedLength: index - startIndex,
      };
    }

    // Skip whitespace after attribute name
    while (index < len && /\s/.test(input[index])) {
      index++;
    }

    // Check if boolean shorthand (no `=` following)
    if (index >= len || input[index] !== "=") {
      props[attrName] = true;
      continue;
    }

    // Move past `=`
    index++;
    while (index < len && /\s/.test(input[index])) {
      index++;
    }
    if (index >= len) {
      return {
        ok: false,
        error: `Missing value for attribute: ${attrName}`,
        incomplete: true,
        consumedLength: index - startIndex,
      };
    }

    const valChar = input[index];
    if (valChar === '"' || valChar === "'") {
      // Quoted string
      const strResult = parseQuotedString(input, valChar, index + 1);
      if ("error" in strResult) {
        return {
          ok: false,
          error: `${strResult.error} for attribute: ${attrName}`,
          incomplete: strResult.incomplete,
          consumedLength: index - startIndex,
        };
      }
      props[attrName] = strResult.value;
      index = strResult.nextIndex;
    } else if (valChar === "{") {
      // Brace-delimited strict JSON
      const braceStart = index;
      index++;
      let depth = 1;
      let inQuote: string | null = null;
      let escaped = false;

      while (index < len && depth > 0) {
        const c = input[index];
        if (inQuote) {
          if (escaped) {
            escaped = false;
          } else if (c === "\\") {
            escaped = true;
          } else if (c === inQuote) {
            inQuote = null;
          }
        } else {
          if (c === '"' || c === "'") {
            inQuote = c;
          } else if (c === "{") {
            depth++;
          } else if (c === "}") {
            depth--;
          }
        }
        index++;
      }

      if (depth !== 0) {
        return {
          ok: false,
          error: `Unmatched brace for attribute: ${attrName}`,
          incomplete: true,
          consumedLength: index - startIndex,
        };
      }

      const innerRaw = input.slice(braceStart + 1, index - 1).trim();

      // Disallow spreads inside braces
      if (innerRaw.startsWith("...")) {
        return {
          ok: false,
          error: `Spread expression rejected in attribute: ${attrName}`,
          incomplete: false,
          consumedLength: index - startIndex,
        };
      }

      // Disallow import/export statements
      if (/(^|\n)\s*(import|export)\s/.test(innerRaw)) {
        return {
          ok: false,
          error: `Import/export rejected in attribute: ${attrName}`,
          incomplete: false,
          consumedLength: index - startIndex,
        };
      }

      // Parse as strict JSON with prototype pollution reviver
      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(innerRaw, (k, val) => {
          if (UNSAFE_OBJECT_KEYS.has(k)) {
            throw new Error(`Unsafe key rejected in JSON: ${k}`);
          }
          return val;
        });
      } catch {
        return {
          ok: false,
          error: `Non-JSON expression rejected in attribute ${attrName}: ${innerRaw}`,
          incomplete: false,
          consumedLength: index - startIndex,
        };
      }

      // Defense in depth: recursively check parsed value for unsafe keys
      if (hasUnsafeObjectKeys(parsedValue)) {
        return {
          ok: false,
          error: `Unsafe object keys rejected in attribute: ${attrName}`,
          incomplete: false,
          consumedLength: index - startIndex,
        };
      }

      props[attrName] = parsedValue;
    } else {
      // Unquoted, un-braced value -> REJECT under strict restricted rules
      return {
        ok: false,
        error: `Unquoted or expression value rejected in attribute ${attrName}`,
        incomplete: false,
        consumedLength: index - startIndex,
      };
    }
  }

  // Freeze safe copy of props
  const safeProps = Object.freeze(Object.assign(Object.create(null), props));
  return {
    ok: true,
    props: deepFreeze(safeProps),
    consumedLength: index - startIndex,
  };
}

/**
 * Parses a single JSX/component tag under strict restricted rules.
 */
export function parseRestrictedTag(raw: string): RestrictedTagParseResult {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("<")) {
    return { ok: false, error: "Not a valid tag", raw, incomplete: false };
  }

  // Closing tag: </Name>
  const closeMatch = /^<\/\s*([A-Za-z][\w-]*)\s*(>|$)/.exec(trimmed);
  if (closeMatch) {
    const tagName = closeMatch[1];
    if (!isRestrictedComponentName(tagName)) {
      return { ok: false, tagName, error: `Invalid component tag casing: ${tagName}`, raw, incomplete: false };
    }
    if (!closeMatch[2]) {
      return { ok: false, tagName, error: "Incomplete closing tag", raw, incomplete: true };
    }
    if (trimmed !== `</${tagName}>` && trimmed !== `</ ${tagName}>` && !/^<\/\s*[A-Za-z][\w-]*\s*>$/.test(trimmed)) {
      return { ok: false, tagName, error: "Trailing characters in closing tag", raw, incomplete: false };
    }
    return { ok: true, kind: "close", tagName, raw };
  }

  // Opening or self-closing tag: <Name ...
  const openNameMatch = /^<\s*([A-Za-z][\w-]*)/.exec(trimmed);
  if (!openNameMatch) {
    return { ok: false, error: "Invalid opening tag syntax", raw, incomplete: false };
  }

  const tagName = openNameMatch[1];
  if (!isRestrictedComponentName(tagName)) {
    return { ok: false, tagName, error: `Invalid component tag name: ${tagName}`, raw, incomplete: false };
  }

  const afterNameIndex = openNameMatch[0].length;
  const attrResult = parseRestrictedAttributes(trimmed, afterNameIndex, ">");
  if (!attrResult.ok) {
    return {
      ok: false,
      tagName,
      error: attrResult.error ?? "Attribute parse error",
      raw,
      incomplete: Boolean(attrResult.incomplete),
    };
  }

  let index = afterNameIndex + attrResult.consumedLength;
  const len = trimmed.length;

  // Skip whitespace before tag close
  while (index < len && /\s/.test(trimmed[index])) {
    index++;
  }

  if (index >= len) {
    return { ok: false, tagName, error: "Unterminated opening tag", raw, incomplete: true };
  }

  if (trimmed.startsWith("/>", index)) {
    if (index + 2 < len) {
      return { ok: false, tagName, error: "Unexpected trailing tokens after self-closing tag", raw, incomplete: false };
    }
    return {
      ok: true,
      kind: "self-closing",
      tagName,
      props: attrResult.props ?? Object.freeze(Object.create(null)),
      raw,
    };
  }

  if (trimmed[index] === ">") {
    if (index + 1 < len) {
      return { ok: false, tagName, error: "Unexpected trailing tokens after tag close", raw, incomplete: false };
    }
    return {
      ok: true,
      kind: "open",
      tagName,
      props: attrResult.props ?? Object.freeze(Object.create(null)),
      raw,
    };
  }

  return { ok: false, tagName, error: "Unterminated tag", raw, incomplete: true };
}
