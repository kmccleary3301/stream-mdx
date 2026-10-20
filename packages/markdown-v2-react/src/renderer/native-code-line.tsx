import { isSafeStyleDeclaration, type CodeLineRecord } from "@stream-mdx/core";
import React from "react";

type NativeCodeTokenSpan = NonNullable<CodeLineRecord["decoration"]>["tokens"]["spans"][number];
type NativeShikiStyle = React.CSSProperties & { [property: `--shiki-${string}`]: string };

const NativeCodeLine = React.memo(function NativeCodeLine({ line }: { line: CodeLineRecord }): React.ReactElement {
  const spans = line.decoration?.tokens.spans;
  const content = spans && spans.length > 0
    ? spans.map((span, index) => React.createElement("span", { key: index, style: nativeCodeTokenStyle(span) }, span.t))
    : line.text;
  const className = line.diffKind ? `line diff-line-${line.diffKind}` : "line";
  return React.createElement(
    "span",
    {
      className,
      "data-line": line.index + 1,
      "data-diff-kind": line.diffKind,
      "data-old-no": line.oldNo == null ? undefined : line.oldNo,
      "data-new-no": line.newNo == null ? undefined : line.newNo,
      "data-provisional": line.isProvisional ? "true" : undefined,
    },
    content,
  );
});

NativeCodeLine.displayName = "NativeCodeLine";

function nativeCodeTokenStyle(span: NativeCodeTokenSpan): NativeShikiStyle {
  const dark = span.v?.dark;
  const light = span.v?.light;
  const single = span.s;
  const style: NativeShikiStyle = {};
  if (dark?.fg && isSafeStyleDeclaration("color", dark.fg)) style["--shiki-dark"] = dark.fg;
  if (light?.fg && isSafeStyleDeclaration("color", light.fg)) style["--shiki-light"] = light.fg;
  if (dark?.bg && isSafeStyleDeclaration("background-color", dark.bg)) style["--shiki-dark-bg"] = dark.bg;
  if (light?.bg && isSafeStyleDeclaration("background-color", light.bg)) style["--shiki-light-bg"] = light.bg;
  if (!dark?.fg && !light?.fg && single?.fg && isSafeStyleDeclaration("color", single.fg)) {
    style.color = single.fg;
  }
  if (!dark?.bg && !light?.bg && single?.bg && isSafeStyleDeclaration("background-color", single.bg)) {
    style.backgroundColor = single.bg;
  }

  const fontStyle = light?.fs ?? dark?.fs ?? single?.fs;
  if (typeof fontStyle === "number" && fontStyle > 0) {
    if (fontStyle & 1) style.fontStyle = "italic";
    if (fontStyle & 2) style.fontWeight = "bold";
    const decorations: string[] = [];
    if (fontStyle & 4) decorations.push("underline");
    if (fontStyle & 8) decorations.push("line-through");
    if (decorations.length > 0) style.textDecoration = decorations.join(" ");
  }
  return style;
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
