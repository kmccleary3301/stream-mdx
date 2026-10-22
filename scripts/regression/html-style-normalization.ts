import type { Page } from "@playwright/test";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

type StyleAttribute = {
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
 * Canonicalize only inline-style values through Chromium CSSOM.
 * All other source bytes remain exact; malformed HTML falls back to strict comparison.
 */
export async function normalizeInlineStyleSerialization(page: Page, html: string): Promise<string> {
  const attributes = collectStyleAttributes(html);
  if (!attributes || attributes.length === 0) return html;

  const styleValues = [...new Set(attributes.map((attribute) => attribute.value))];
  const canonicalValues = await page.evaluate((values) => {
    return values.map((value) => {
      const declaration = document.createElement("span").style;
      declaration.cssText = value;
      return declaration.cssText;
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
    const value = escapeAttributeValue(canonicalValue, attribute.quote);
    normalized = `${normalized.slice(0, attribute.valueStart)}${value}${normalized.slice(attribute.valueEnd)}`;
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
