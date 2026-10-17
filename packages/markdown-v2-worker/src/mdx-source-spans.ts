import type { Nodes as MdastNode, Root } from "mdast";
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

/** Shared exact MDAST direct-child offsets for full compilation and worker ownership recognition. */
export function readTrustedMdxFlowChildSpans(
  children: readonly MdastNode[] | undefined,
  sourceLength: number,
): readonly TrustedMdxFlowChildSpan[] | null {
  if (!children) return null;
  const spans: TrustedMdxFlowChildSpan[] = [];
  for (const child of children) {
    const from = child.position?.start.offset;
    const to = child.position?.end.offset;
    if (
      typeof from !== "number" || !Number.isSafeInteger(from) ||
      typeof to !== "number" || !Number.isSafeInteger(to) ||
      from < 0 || to > sourceLength || to <= from
    ) return null;
    spans.push({
      from,
      to,
      kind: child.type === "mdxJsxFlowElement" ? "jsx" : child.type === "mdxFlowExpression" ? "expression" : "markdown",
    });
  }
  return spans;
}

/** Collect only authored MDX leaves; placement and flow-child spans come from MDAST node kinds. */
export function collectTrustedMdxSourceSpans(
  tree: Root,
  sourceLength: number,
): readonly TrustedMdxSourceSpan[] {
  const spans: TrustedMdxSourceSpan[] = [];
  const collectMdxLeaves = (node: MdastNode): void => {
    const isMdxJsx = node.type === "mdxJsxTextElement" || node.type === "mdxJsxFlowElement";
    const isMdxExpression = node.type === "mdxTextExpression" || node.type === "mdxFlowExpression";
    const placement = node.type === "mdxJsxFlowElement" || node.type === "mdxFlowExpression" ? "flow" : "inline";
    const rootElementName = node.type === "mdxJsxFlowElement" ? node.name : undefined;
    const hasFlowChildren =
      node.type === "mdxJsxFlowElement" &&
      node.children.length > 0;
    const flowChildren =
      node.type === "mdxJsxFlowElement"
        ? readTrustedMdxFlowChildSpans(node.children, sourceLength)
        : null;
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
        if (node.type === "mdxJsxFlowElement") {
          for (const child of node.children) collectMdxLeaves(child);
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
