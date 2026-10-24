import type { Nodes as MdastNode, Paragraph, Root } from "mdast";
import { VFileMessage } from "vfile-message";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { TrustedMdxFlowChildSpan } from "@stream-mdx/core";

export interface TrustedMdxSourceSpan {
  readonly from: number;
  readonly to: number;
  readonly kind: "jsx" | "expression";
  readonly placement: "flow" | "inline";
  readonly rootElementName?: string | null;
  readonly hasFlowChildren?: boolean;
  readonly flowChildren?: readonly TrustedMdxFlowChildSpan[];
}

export type TrustedMdxSourceSpanParseResult =
  | { readonly kind: "parsed"; readonly regions: readonly TrustedMdxSourceSpan[] }
  | { readonly kind: "not-complete" };

const mdxSourceParser = unified().use(remarkParse).use(remarkMdx).use(remarkGfm).use(remarkMath);
const mdxSyntaxMessageSources = new Set([
  "micromark-extension-mdx-expression",
  "micromark-extension-mdx-jsx",
  "micromark-extension-mdxjs-esm",
  "mdast-util-mdx-jsx",
]);

type SourceSpanParser = (source: string) => Root;

function parseMdxSource(source: string): Root {
  return mdxSourceParser.parse(source);
}

function isExpectedMdxSyntaxMessage(error: unknown): error is VFileMessage {
  return (
    error instanceof VFileMessage &&
    typeof error.source === "string" &&
    mdxSyntaxMessageSources.has(error.source)
  );
}

const htmlNonWhitespace = /[^\t\n\v\f\r ]/;
const unraveledWhitespace = /^[\t\r\n ]+$/;

// MDX promotes paragraphs containing only JSX/expressions and HTML whitespace.
// Read that same view without importing the compiler or mutating parser-owned nodes.
function isStandaloneMdxParagraph(paragraph: Paragraph): boolean {
  let hasMdx = false;
  for (const child of paragraph.children) {
    if (child.type === "mdxJsxTextElement" || child.type === "mdxTextExpression") {
      hasMdx = true;
    } else if (child.type !== "text" || htmlNonWhitespace.test(child.value)) {
      return false;
    }
  }
  return hasMdx;
}

function isUnraveledWhitespace(node: MdastNode): boolean {
  return node.type === "text" && unraveledWhitespace.test(node.value);
}

function isMdastPhrasing(node: MdastNode): boolean {
  switch (node.type) {
    case "text":
    case "emphasis":
    case "strong":
    case "delete":
    case "inlineCode":
    case "link":
    case "linkReference":
    case "image":
    case "imageReference":
    case "break":
    case "inlineMath":
    case "footnoteReference":
    case "mdxJsxTextElement":
    case "mdxTextExpression":
      return true;
    default:
      return false;
  }
}

function appendFlowChildSpan(
  spans: TrustedMdxFlowChildSpan[],
  child: MdastNode,
  sourceLength: number,
  promoted = false,
): boolean {
  const from = child.position?.start.offset;
  const to = child.position?.end.offset;
  if (
    typeof from !== "number" || !Number.isSafeInteger(from) ||
    typeof to !== "number" || !Number.isSafeInteger(to) ||
    from < 0 || to > sourceLength || to <= from
  ) return false;
  const flowJsx = child.type === "mdxJsxFlowElement" || (promoted && child.type === "mdxJsxTextElement");
  const flowExpression = child.type === "mdxFlowExpression" || (promoted && child.type === "mdxTextExpression");
  spans.push({ from, to, kind: flowJsx ? "jsx" : flowExpression ? "expression" : isMdastPhrasing(child) ? "inline" : "markdown" });
  return true;
}

/** Shared exact MDAST direct-child offsets for full compilation and worker ownership recognition. */
export function readTrustedMdxFlowChildSpans(
  children: readonly MdastNode[] | undefined,
  sourceLength: number,
): readonly TrustedMdxFlowChildSpan[] | null {
  if (!children) return null;
  const spans: TrustedMdxFlowChildSpan[] = [];
  for (const child of children) {
    if (child.type === "paragraph" && isStandaloneMdxParagraph(child)) {
      for (const promoted of child.children) {
        if (!isUnraveledWhitespace(promoted) && !appendFlowChildSpan(spans, promoted, sourceLength, true)) return null;
      }
    } else if (!appendFlowChildSpan(spans, child, sourceLength)) {
      return null;
    }
  }
  return spans;
}

/** Collect authored MDX leaves using the compiler-normalized MDAST view. */
export function collectTrustedMdxSourceSpans(
  tree: Root,
  sourceLength: number,
): readonly TrustedMdxSourceSpan[] {
  const spans: TrustedMdxSourceSpan[] = [];
  const collectMdxLeaves = (node: MdastNode, promoted = false): void => {
    if (node.type === "paragraph" && isStandaloneMdxParagraph(node)) {
      for (const child of node.children) {
        if (!isUnraveledWhitespace(child)) collectMdxLeaves(child, true);
      }
      return;
    }
    const isMdxJsx = node.type === "mdxJsxTextElement" || node.type === "mdxJsxFlowElement";
    const isMdxExpression = node.type === "mdxTextExpression" || node.type === "mdxFlowExpression";
    const flowRoot = node.type === "mdxJsxFlowElement" || (promoted && node.type === "mdxJsxTextElement")
      ? node
      : undefined;
    const placement = flowRoot || node.type === "mdxFlowExpression" || (promoted && node.type === "mdxTextExpression")
      ? "flow"
      : "inline";
    const rootElementName = flowRoot?.name;
    const hasFlowChildren = flowRoot !== undefined && flowRoot.children.length > 0;
    const flowChildren = flowRoot ? readTrustedMdxFlowChildSpans(flowRoot.children, sourceLength) : null;
    if (isMdxJsx || isMdxExpression) {
      const position = node.position;
      if (
        position &&
        typeof position.start.offset === "number" &&
        Number.isInteger(position.start.offset) &&
        typeof position.end.offset === "number" &&
        Number.isInteger(position.end.offset) &&
        position.start.offset >= 0 &&
        position.end.offset <= sourceLength &&
        position.start.offset < position.end.offset
      ) {
        spans.push({
          from: position.start.offset,
          to: position.end.offset,
          kind: isMdxJsx ? "jsx" : "expression",
          placement,
          ...(rootElementName === undefined
            ? {}
            : {
                rootElementName,
                hasFlowChildren,
                ...(flowChildren === null ? {} : { flowChildren }),
              }),
        });
        if (flowRoot) {
          for (const child of flowRoot.children) collectMdxLeaves(child);
        }
        return;
      }
    }
    if ("children" in node) {
      for (const child of node.children) collectMdxLeaves(child);
    }
  };

  for (const child of tree.children) collectMdxLeaves(child);
  spans.sort((left, right) => left.from - right.from || left.to - right.to);
  return spans;
}

/** Parse source only; expected MDX syntax messages defer ownership to the host compiler. */
export function parseTrustedMdxSourceSpans(
  source: string,
  parseSource: SourceSpanParser = parseMdxSource,
): TrustedMdxSourceSpanParseResult {
  let tree: Root;
  try {
    tree = parseSource(source);
  } catch (error) {
    if (isExpectedMdxSyntaxMessage(error)) return { kind: "not-complete" };
    throw error;
  }
  return { kind: "parsed", regions: collectTrustedMdxSourceSpans(tree, source.length) };
}
