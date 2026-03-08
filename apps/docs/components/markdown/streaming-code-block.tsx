"use client";

import { cn } from "@/lib/utils";
import { DocsCodeBlock } from "@/components/markdown/docs-code-block";

export function StreamingCodeBlock({
  code,
  language = "text",
  className,
}: {
  code: string;
  language?: string;
  className?: string;
}) {
  return (
    <div className={cn("max-w-none text-sm text-foreground", className)}>
      <div className="markdown-v2-output">
        <DocsCodeBlock
          html=""
          meta={{ code, lang: language }}
          lines={[]}
          lang={language}
        />
      </div>
    </div>
  );
}
