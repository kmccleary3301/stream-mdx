"use client";

import { ScrollAreaHorizontal } from "@/components/ui/scroll-area";
import katex from "katex";
import "katex/dist/katex.min.css";

export function InlineMath({ math }: { math: string }) {
  try {
    const html = katex.renderToString(math, { throwOnError: false, displayMode: false });
    // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output is trusted
    return <span className="katex-inline" dangerouslySetInnerHTML={{ __html: html }} />;
  } catch {
    return <span>{`$${math}$`}</span>;
  }
}

export function BlockMath({ math }: { math: string }) {
  try {
    const html = katex.renderToString(math, { throwOnError: false, displayMode: true });
    return (
      <div className="katex-block-wrapper my-2">
        <ScrollAreaHorizontal className="w-full max-w-full">
          <div style={{ minWidth: "100%", display: "table" }}>
            <span
              className="word-break whitespace-pre-wrap"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output is trusted
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        </ScrollAreaHorizontal>
      </div>
    );
  } catch {
    return (
      <div className="katex-block-wrapper my-2">
        <ScrollAreaHorizontal className="w-full max-w-full">
          <div style={{ minWidth: "100%", display: "table" }}>
            <pre className="m-0 whitespace-pre-wrap">{`$$\n${math}\n$$`}</pre>
          </div>
        </ScrollAreaHorizontal>
      </div>
    );
  }
}

