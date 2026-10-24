import type { Page } from "@playwright/test";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

type StyleAttribute = {
  attributeStart: number;
  valueStart: number;
  valueEnd: number;
  value: string;
  quote: "\"" | "'";
};

export type TopLevelElementHtml = {
  tag: string;
  html: string;
};

function findAttributeValueRange(
  html: string,
  start: number,
  end: number,
): { valueStart: number; valueEnd: number; quote: "\"" | "'" } | null {
  let cursor = start;
  while (cursor < end && html[cursor] !== "=") cursor += 1;
  if (cursor === end) return null;

  cursor += 1;
  while (cursor < end && /\s/.test(html[cursor])) cursor += 1;
  const quote = html[cursor];
  if (quote !== "\"" && quote !== "'") return null;

  const valueStart = cursor + 1;
  const valueEnd = end - 1;
  if (html[valueEnd] !== quote) return null;
  return { valueStart, valueEnd, quote };
}

function escapeAttributeValue(value: string, quote: "\"" | "'"): string {
  const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return quote === "\"" ? escaped.replace(/"/g, "&quot;") : escaped.replace(/'/g, "&#39;");
}

function collectStyleAttributes(html: string): StyleAttribute[] | null {
  let hasParseError = false;
  const fragment = parseFragment(html, {
    sourceCodeLocationInfo: true,
    onParseError: () => {
      hasParseError = true;
    },
  });
  const attributes: StyleAttribute[] = [];

  function visit(node: DefaultTreeAdapterMap["node"]): void {
    if ("attrs" in node) {
      const styleAttributes = node.attrs.filter((attribute) => attribute.name.toLowerCase() === "style" && !attribute.prefix);
      if (styleAttributes.length > 1) {
        hasParseError = true;
        return;
      }
      if (styleAttributes.length === 1) {
        const styleAttribute = styleAttributes[0];
        const location = node.sourceCodeLocation?.attrs?.style;
        const valueRange = location ? findAttributeValueRange(html, location.startOffset, location.endOffset) : null;
        if (!styleAttribute || !location || !valueRange) {
          hasParseError = true;
          return;
        }
        attributes.push({
          ...valueRange,
          attributeStart: location.startOffset,
          value: styleAttribute.value,
        });
      }
    }

    if ("childNodes" in node) {
      for (const child of node.childNodes) visit(child);
    }
    if ("content" in node) visit(node.content);
  }

  visit(fragment);
  return hasParseError ? null : attributes;
}

/**
 * Canonicalize only inline-style attributes through Chromium CSSOM: declarations become sorted longhands, and an
 * empty style attribute is removed. All other source bytes remain exact; malformed HTML falls back to strict comparison.
 */
export async function normalizeInlineStyleSerialization(page: Page, html: string): Promise<string> {
  const attributes = collectStyleAttributes(html);
  if (!attributes || attributes.length === 0) return html;

  const styleValues = [...new Set(attributes.map((attribute) => attribute.value))];
  const canonicalValues = await page.evaluate((values) => {
    return values.map((value) => {
      const declaration = document.createElement("span").style;
      declaration.cssText = value;
      // Longhand expansion keeps shorthand/longhand cascade results; order then only records mutation history.
      const declarations: string[] = [];
      for (let index = 0; index < declaration.length; index += 1) {
        const property = declaration.item(index);
        const priority = declaration.getPropertyPriority(property);
        declarations.push(`${property}: ${declaration.getPropertyValue(property)}${priority ? ` !${priority}` : ""};`);
      }
      return declarations.sort().join(" ");
    });
  }, styleValues);
  if (canonicalValues.length !== styleValues.length) {
    throw new Error("CSSOM returned a different number of inline-style values than requested.");
  }
  const canonicalByValue = new Map<string, string>();
  for (let index = 0; index < styleValues.length; index += 1) {
    const value = canonicalValues[index];
    if (value === undefined) {
      throw new Error("CSSOM style normalization lost a value during parsing.");
    }
    canonicalByValue.set(styleValues[index], value);
  }

  let normalized = html;
  for (let index = attributes.length - 1; index >= 0; index -= 1) {
    const attribute = attributes[index];
    if (!attribute) {
      throw new Error("CSSOM style normalization lost an attribute during source replacement.");
    }
    const canonicalValue = canonicalByValue.get(attribute.value);
    if (canonicalValue === undefined) {
      throw new Error("CSSOM style normalization lost an attribute value during source replacement.");
    }
    if (canonicalValue === "") {
      let start = attribute.attributeStart;
      while (start > 0 && /\s/.test(normalized[start - 1] ?? "")) start -= 1;
      normalized = `${normalized.slice(0, start)}${normalized.slice(attribute.valueEnd + 1)}`;
      continue;
    }
    const value = escapeAttributeValue(canonicalValue, attribute.quote);
    normalized = `${normalized.slice(0, attribute.valueStart)}${value}${normalized.slice(attribute.valueEnd)}`;
  }
  return normalized;
}

/**
 * Sort each start tag's attributes by name. DOM attribute order records mutation history, not meaning.
 * Attribute source text is reused verbatim; malformed HTML falls back to strict comparison.
 */
export function canonicalizeAttributeOrder(html: string): string {
  let hasParseError = false;
  const fragment = parseFragment(html, {
    sourceCodeLocationInfo: true,
    onParseError: () => {
      hasParseError = true;
    },
  });
  const edits: Array<{ start: number; end: number; text: string }> = [];

  function visit(node: DefaultTreeAdapterMap["node"]): void {
    if ("attrs" in node && node.attrs.length > 1) {
      const locations = node.sourceCodeLocation?.attrs;
      const ranges = node.attrs.map((attribute) => {
        const name = attribute.prefix ? `${attribute.prefix}:${attribute.name}` : attribute.name;
        const location = locations?.[name];
        return location ? { name, start: location.startOffset, end: location.endOffset } : null;
      });
      if (ranges.some((range) => range === null)) {
        hasParseError = true;
        return;
      }
      const ordered = (ranges as Array<{ name: string; start: number; end: number }>).slice().sort((a, b) => a.start - b.start);
      const sorted = ordered.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      edits.push({
        start: ordered[0]!.start,
        end: ordered[ordered.length - 1]!.end,
        text: sorted.map((range) => html.slice(range.start, range.end)).join(" "),
      });
    }
    if ("childNodes" in node) {
      for (const child of node.childNodes) visit(child);
    }
    if ("content" in node) visit(node.content);
  }

  visit(fragment);
  if (hasParseError) return html;
  let normalized = html;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    normalized = `${normalized.slice(0, edit.start)}${edit.text}${normalized.slice(edit.end)}`;
  }
  return normalized;
}

export function extractTopLevelElementHtml(html: string): TopLevelElementHtml[] {
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true });
  const elements: TopLevelElementHtml[] = [];

  for (const node of fragment.childNodes) {
    if (!("tagName" in node) || !node.sourceCodeLocation) continue;
    elements.push({
      tag: node.tagName.toLowerCase(),
      html: html.slice(node.sourceCodeLocation.startOffset, node.sourceCodeLocation.endOffset),
    });
  }
  return elements;
}
