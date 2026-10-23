import { isSafeStyleDeclaration, type CodeLineRecord } from "@stream-mdx/core";
import React from "react";

type NativeCodeTokenSpan = NonNullable<CodeLineRecord["decoration"]>["tokens"]["spans"][number];
type NativeShikiStyle = React.CSSProperties & { [property: `--shiki-${string}`]: string };
type NativeTokenDeclaration = readonly [property: string, value: string];

type NativeCodeLineProps = {
  line: CodeLineRecord;
  decoration: CodeLineRecord["decoration"];
};

const NativeCodeLine = React.memo(function NativeCodeLine({
  line,
  decoration,
}: NativeCodeLineProps): React.ReactElement {
  const spans = decoration?.tokens.spans;
  const content = spans && spans.length > 0
    ? spans.map((span, index) => React.createElement("span", { key: index, style: nativeCodeTokenStyle(span) }, span.t))
    : line.text;
  return React.createElement("span", nativeCodeLineAttributes(line), content);
});

NativeCodeLine.displayName = "NativeCodeLine";


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
  const spans = line.decoration?.tokens.spans;
  const content = spans && spans.length > 0
    ? spans.map((span) => {
      const style = nativeCodeTokenDeclarations(span).map(([property, value]) => `${property}:${value}`).join(";");
      return style ? `<span style="${escapeCodeHtml(style)}">${escapeCodeHtml(span.t)}</span>` : `<span>${escapeCodeHtml(span.t)}</span>`;
    }).join("")
    : escapeCodeHtml(line.text);
  let attributes = "";
  for (const [name, value] of Object.entries(nativeCodeLineAttributes(line))) {
    if (value === undefined) continue;
    attributes += ` ${name === "className" ? "class" : name}="${escapeCodeHtml(String(value))}"`;
  }
  return `<span${attributes}>${content}</span>${line.ending ? "\n" : ""}`;
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

type NativeCodeLineGroupProps = {
  line: CodeLineRecord;
  generation: number;
  selectedForNativeSelection: boolean;
};

type CommittedCodeLinePresentation = {
  id: string;
  sourceRevision: number;
  generation: number;
  text: string;
  decoration: CodeLineRecord["decoration"];
};

export const NativeCodeLineGroup = React.memo(function NativeCodeLineGroup({
  line,
  generation,
  selectedForNativeSelection,
}: NativeCodeLineGroupProps): React.ReactElement {
  const committedPresentationRef = React.useRef<CommittedCodeLinePresentation | null>(null);
  const committedPresentation = committedPresentationRef.current;
  const preserveCommittedDecoration =
    selectedForNativeSelection &&
    committedPresentation !== null &&
    committedPresentation.id === line.id &&
    committedPresentation.sourceRevision === line.sourceRevision &&
    committedPresentation.generation === generation &&
    committedPresentation.text === line.text;
  const decoration = preserveCommittedDecoration
    ? committedPresentation.decoration
    : line.decoration;

  React.useLayoutEffect(() => {
    if (preserveCommittedDecoration) return;
    const committed = committedPresentationRef.current;
    if (committed) {
      committed.id = line.id;
      committed.sourceRevision = line.sourceRevision;
      committed.generation = generation;
      committed.text = line.text;
      committed.decoration = decoration;
    } else {
      committedPresentationRef.current = {
        id: line.id,
        sourceRevision: line.sourceRevision,
        generation,
        text: line.text,
        decoration,
      };
    }
  }, [decoration, generation, line.id, line.sourceRevision, line.text, preserveCommittedDecoration]);

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(NativeCodeLine, { line, decoration }),
    line.ending ? "\n" : null,
  );
});

NativeCodeLineGroup.displayName = "NativeCodeLineGroup";
