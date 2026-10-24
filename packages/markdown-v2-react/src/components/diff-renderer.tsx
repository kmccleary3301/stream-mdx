import type { DiffBlock, DiffLine } from "@stream-mdx/core";
import React from "react";
export interface DiffRendererProps {
  meta?: Record<string, unknown>;
  renderCode: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export const DefaultDiffRenderer: React.FC<DiffRendererProps> = ({
  meta,
  renderCode,
  className = "",
  style,
}) => {
  const diffBlocks = Array.isArray(meta?.diffBlocks) ? (meta.diffBlocks as DiffBlock[]) : null;

  if (!diffBlocks || diffBlocks.length === 0) {
    return <>{renderCode}</>;
  }

  return (
    <div
      className={`stream-mdx-diff-container my-4 rounded-md border border-border bg-muted/20 font-mono text-sm overflow-hidden ${className}`.trim()}
      style={style}
    >
      {diffBlocks.map((diffBlock, bIdx) => (
        <div key={bIdx} className="stream-mdx-diff-block">
          {(diffBlock.filePath || diffBlock.additions != null || diffBlock.deletions != null) && (
            <div className="stream-mdx-diff-header flex items-center justify-between border-b border-border bg-muted/40 px-4 py-2 text-xs font-semibold text-muted-foreground">
              <span className="stream-mdx-diff-filepath">{diffBlock.filePath ?? "diff"}</span>
              <span className="stream-mdx-diff-stats flex gap-2">
                {diffBlock.additions != null && (
                  <span className="stream-mdx-diff-stat-add text-green-600 dark:text-green-400">
                    +{diffBlock.additions}
                  </span>
                )}
                {diffBlock.deletions != null && (
                  <span className="stream-mdx-diff-stat-del text-red-600 dark:text-red-400">
                    -{diffBlock.deletions}
                  </span>
                )}
              </span>
            </div>
          )}
          <div className="stream-mdx-diff-lines overflow-x-auto">
            <table className="w-full border-collapse font-mono text-xs">
              <tbody>
                {diffBlock.lines.map((line: DiffLine, lIdx: number) => {
                  const kindClass = `diff-line-${line.kind} ${
                    line.kind === "add"
                      ? "bg-green-500/10 text-green-900 dark:text-green-200"
                      : line.kind === "del"
                        ? "bg-red-500/10 text-red-900 dark:text-red-200"
                        : line.kind === "hunk"
                          ? "bg-blue-500/10 text-blue-800 dark:text-blue-300 font-semibold"
                          : line.kind === "meta"
                            ? "bg-muted/50 text-muted-foreground italic"
                            : "text-foreground"
                  }`;

                  return (
                    <tr
                      key={lIdx}
                      className={`stream-mdx-diff-row ${kindClass}`}
                      data-diff-kind={line.kind}
                    >
                      <td className="stream-mdx-diff-old-no select-none px-2 py-0.5 text-right opacity-50 w-10">
                        {line.oldNo != null ? line.oldNo : ""}
                      </td>
                      <td className="stream-mdx-diff-new-no select-none px-2 py-0.5 text-right opacity-50 w-10">
                        {line.newNo != null ? line.newNo : ""}
                      </td>
                      <td className="stream-mdx-diff-prefix select-none px-1 py-0.5 text-center w-4 font-bold">
                        {line.kind === "add" ? "+" : line.kind === "del" ? "-" : line.kind === "hunk" ? "@" : " "}
                      </td>
                      <td className="stream-mdx-diff-content px-2 py-0.5 whitespace-pre">
                        {line.tokens && line.tokens.length > 0 ? (
                          line.tokens.map((token, tIdx) => (
                            <span
                              key={tIdx}
                              style={{
                                color: token.color ?? undefined,
                                fontStyle:
                                  token.fontStyle === 1 || token.fontStyle === 3 ? "italic" : undefined,
                                fontWeight:
                                  token.fontStyle === 2 || token.fontStyle === 3 ? "bold" : undefined,
                              }}
                            >
                              {token.content}
                            </span>
                          ))
                        ) : (
                          <span>{line.raw.replace(/^[+\- ]/, "")}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
};

DefaultDiffRenderer.displayName = "DefaultDiffRenderer";
