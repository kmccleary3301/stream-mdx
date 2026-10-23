import { isSafeStyleDeclaration, type CodeLineRecord, type CodeTokenLine } from "@stream-mdx/core";
import React from "react";

type NativeCodeTokenSpan = CodeTokenLine["spans"][number];
type NativeShikiStyle = React.CSSProperties & { [property: `--shiki-${string}`]: string };
type NativeTokenDeclaration = readonly [property: string, value: string];

const NativeCodeLine = React.memo(function NativeCodeLine({ line }: { line: CodeLineRecord }): React.ReactElement {
  const decoration = line.decoration;
  const spans = decoration && decoration.exactness !== "unavailable" ? decoration.tokens.spans : undefined;
  const marker = nativeCodeLineMarker(line);
  const content = spans !== undefined
    ? spans.map((span, index) => React.createElement("span", { key: index, style: nativeCodeTokenStyle(span) }, span.t))
    : nativeCodeLineSourceContent(line, marker);
  return React.createElement("span", nativeCodeLineAttributes(line), marker, content);
});

NativeCodeLine.displayName = "NativeCodeLine";

function nativeCodeLineMarker(line: CodeLineRecord): string {
  const expected = line.diffKind === "add"
    ? "+"
    : line.diffKind === "del"
      ? "-"
      : line.diffKind === "context"
        ? " "
        : "";
  return expected !== "" && line.text.startsWith(expected) ? expected : "";
}

function nativeCodeLineSourceContent(line: CodeLineRecord, marker: string): string {
  return marker ? line.text.slice(marker.length) : line.text;
}

function nativeCodeLineAttributes(line: CodeLineRecord): Record<string, string | number | undefined> {
  return {
    className: line.diffKind ? `line diff-line-${line.diffKind}` : "line",
    "data-line": line.index + 1,
    "data-diff-kind": line.diffKind,
    "data-old-no": line.oldNo == null ? undefined : line.oldNo,
    "data-new-no": line.newNo == null ? undefined : line.newNo,
    "data-provisional": line.isProvisional ? "true" : undefined,
  };
}

function nativeCodeTokenDeclarations(span: NativeCodeTokenSpan): NativeTokenDeclaration[] {
  const dark = span.v?.dark;
  const light = span.v?.light;
  const single = span.s;
  const declarations: NativeTokenDeclaration[] = [];
  if (dark?.fg && isSafeStyleDeclaration("color", dark.fg)) declarations.push(["--shiki-dark", dark.fg]);
  if (light?.fg && isSafeStyleDeclaration("color", light.fg)) declarations.push(["--shiki-light", light.fg]);
  if (dark?.bg && isSafeStyleDeclaration("background-color", dark.bg)) declarations.push(["--shiki-dark-bg", dark.bg]);
  if (light?.bg && isSafeStyleDeclaration("background-color", light.bg)) declarations.push(["--shiki-light-bg", light.bg]);
  if (!dark?.fg && !light?.fg && single?.fg && isSafeStyleDeclaration("color", single.fg)) {
    declarations.push(["color", single.fg]);
  }
  if (!dark?.bg && !light?.bg && single?.bg && isSafeStyleDeclaration("background-color", single.bg)) {
    declarations.push(["background-color", single.bg]);
  }

  const fontStyle = light?.fs ?? dark?.fs ?? single?.fs;
  if (typeof fontStyle === "number" && fontStyle > 0) {
    if (fontStyle & 1) declarations.push(["font-style", "italic"]);
    if (fontStyle & 2) declarations.push(["font-weight", "bold"]);
    const decorations: string[] = [];
    if (fontStyle & 4) decorations.push("underline");
    if (fontStyle & 8) decorations.push("line-through");
    if (decorations.length > 0) declarations.push(["text-decoration", decorations.join(" ")]);
  }
  return declarations;
}

function nativeCodeTokenStyle(span: NativeCodeTokenSpan): NativeShikiStyle {
  const style: Record<string, string> = {};
  for (const [property, value] of nativeCodeTokenDeclarations(span)) {
    style[property.startsWith("--") ? property : property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  return style as NativeShikiStyle;
}

function escapeCodeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Static markup of one native line, identical in structure and token styles to `NativeCodeLineGroup`. */
function nativeCodeLineHtml(line: CodeLineRecord): string {
  const decoration = line.decoration;
  const spans = decoration && decoration.exactness !== "unavailable" ? decoration.tokens.spans : undefined;
  const marker = nativeCodeLineMarker(line);
  const content = spans !== undefined
    ? spans.map((span) => {
      const style = nativeCodeTokenDeclarations(span).map(([property, value]) => `${property}:${value}`).join(";");
      return style ? `<span style="${escapeCodeHtml(style)}">${escapeCodeHtml(span.t)}</span>` : `<span>${escapeCodeHtml(span.t)}</span>`;
    }).join("")
    : escapeCodeHtml(nativeCodeLineSourceContent(line, marker));
  let attributes = "";
  for (const [name, value] of Object.entries(nativeCodeLineAttributes(line))) {
    if (value === undefined) continue;
    attributes += ` ${name === "className" ? "class" : name}="${escapeCodeHtml(String(value))}"`;
  }
  return `<span${attributes}>${escapeCodeHtml(marker)}${content}</span>${line.ending ? "\n" : ""}`;
}

const HTML_ATTRIBUTE_NAME = /^[A-Za-z_:][-A-Za-z0-9_:.]*$/;

function codeWrapperAttributes(attributes: Record<string, string> | undefined): string {
  let serialized = "";
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (HTML_ATTRIBUTE_NAME.test(name)) serialized += ` ${name}="${escapeCodeHtml(String(value))}"`;
  }
  return serialized;
}

/**
 * Highlighted markup for registered code components that render `html`. Empty until every line carries its
 * decoration, so such components keep rendering line text while highlighting is pending.
 */
export function nativeCodeBlockHtml(
  lines: readonly CodeLineRecord[],
  preAttrs: Record<string, string> | undefined,
  codeAttrs: Record<string, string> | undefined,
): string {
  if (lines.length === 0 || lines.some((line) => line.decoration === undefined)) return "";
  return `<pre${codeWrapperAttributes(preAttrs)}><code${codeWrapperAttributes(codeAttrs)}>${lines.map(nativeCodeLineHtml).join("")}</code></pre>`;
}

export const NativeCodeLineGroup = React.memo(function NativeCodeLineGroup({ line }: { line: CodeLineRecord }): React.ReactElement {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(NativeCodeLine, { line }),
    line.ending ? "\n" : null,
  );
});

NativeCodeLineGroup.displayName = "NativeCodeLineGroup";
