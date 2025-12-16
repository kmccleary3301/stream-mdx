import type { InlineNode } from "@stream-mdx/core";

export type InlineStreamingStatus = "complete" | "partial";

type ParseInline = (content: string) => InlineNode[];

export interface StreamingInlineResult {
  nodes: InlineNode[];
  status: InlineStreamingStatus;
  safeLength: number;
}

export function computeStreamingInline(content: string, parseInline: ParseInline): StreamingInlineResult {
  if (!content) {
    return { nodes: [], status: "complete", safeLength: 0 };
  }

  const safeLength = findSafeInlineBoundary(content);
  if (safeLength >= content.length) {
    return {
      nodes: parseInline(content),
      status: "complete",
      safeLength: content.length,
    };
  }

  const prefix = safeLength > 0 ? content.slice(0, safeLength) : "";
  const suffix = content.slice(safeLength);
  const nodes: InlineNode[] = [];

  if (prefix) {
    nodes.push(...parseInline(prefix));
  }
  if (suffix) {
    nodes.push({ kind: "text", text: suffix });
  }

  return {
    nodes: nodes.length > 0 ? nodes : [{ kind: "text", text: content }],
    status: nodes.length > 0 && suffix.length > 0 ? "partial" : "complete",
    safeLength,
  };
}

function findSafeInlineBoundary(content: string): number {
  const length = content.length;
  let cutoff = length;

  const recordUnsafe = (index: number | null | undefined) => {
    if (typeof index === "number" && index >= 0) {
      cutoff = Math.min(cutoff, index);
    }
  };

  // Backticks (`code`)
  recordUnsafe(scanBackticks(content));

  // Strikethrough (~~)
  recordUnsafe(scanDoubleChar(content, "~"));

  // Emphasis strong (**) and single (*)
  recordUnsafe(scanEmphasis(content, "*"));
  recordUnsafe(scanEmphasis(content, "_"));

  // Inline & display math ($ ... $, $$ ... $$)
  const { inline: inlineDollar, display: displayDollar } = scanDollarDelimiters(content);
  recordUnsafe(inlineDollar);
  recordUnsafe(displayDollar);

  return cutoff;
}

function scanBackticks(content: string): number | null {
  let openIndex: number | null = null;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === "`") {
      if (openIndex === null) {
        openIndex = i;
      } else {
        openIndex = null;
      }
    }
  }
  return openIndex;
}

function scanDoubleChar(content: string, char: string): number | null {
  const stack: number[] = [];
  for (let i = 0; i < content.length - 1; i++) {
    if (content[i] === "\\" && content[i + 1] === char) {
      i++;
      continue;
    }
    if (content[i] === char && content[i + 1] === char) {
      if (stack.length > 0) {
        stack.pop();
      } else {
        stack.push(i);
      }
      i++;
    }
  }
  return stack.length > 0 ? stack[stack.length - 1] : null;
}

function scanEmphasis(content: string, marker: "*" | "_"): number | null {
  const singleStack: number[] = [];
  const doubleStack: number[] = [];
  const length = content.length;

  let i = 0;
  while (i < length) {
    if (content[i] === "\\") {
      i += 2;
      continue;
    }
    if (content[i] !== marker) {
      i++;
      continue;
    }
    let run = 1;
    while (i + run < length && content[i + run] === marker) {
      run++;
    }

    const pairs = Math.floor(run / 2);
    for (let p = 0; p < pairs; p++) {
      if (doubleStack.length > 0) {
        doubleStack.pop();
      } else {
        doubleStack.push(i + p * 2);
      }
    }

    if (run % 2 === 1) {
      const pos = i + run - 1;
      if (singleStack.length > 0) {
        singleStack.pop();
      } else {
        singleStack.push(pos);
      }
    }

    i += run;
  }

  if (singleStack.length > 0) {
    return singleStack[singleStack.length - 1];
  }
  if (doubleStack.length > 0) {
    return doubleStack[doubleStack.length - 1];
  }
  return null;
}

function scanDollarDelimiters(content: string): { inline: number | null; display: number | null } {
  const inlineStack: number[] = [];
  const displayStack: number[] = [];
  const length = content.length;

  let i = 0;
  while (i < length) {
    const char = content[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char !== "$") {
      i++;
      continue;
    }
    const isDouble = i + 1 < length && content[i + 1] === "$";
    if (isDouble) {
      if (displayStack.length > 0) {
        displayStack.pop();
      } else {
        displayStack.push(i);
      }
      i += 2;
      continue;
    }
    if (inlineStack.length > 0) {
      inlineStack.pop();
    } else {
      inlineStack.push(i);
    }
    i++;
  }

  return {
    inline: inlineStack.length > 0 ? inlineStack[inlineStack.length - 1] : null,
    display: displayStack.length > 0 ? displayStack[displayStack.length - 1] : null,
  };
}
