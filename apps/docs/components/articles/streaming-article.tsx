"use client";

import { StreamingMarkdown } from "@stream-mdx/react";
import { useEffect, useMemo, useRef } from "react";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function StreamingArticle({ content }: { content: string }) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const assignHeadingIds = useMemo(() => {
    return () => {
      const root = wrapperRef.current;
      if (!root) return;
      const headings = Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"));
      const counts = new Map<string, number>();
      for (const heading of headings) {
        const text = heading.textContent?.trim() ?? "";
        const base = slugify(text) || "section";
        const count = counts.get(base) ?? 0;
        counts.set(base, count + 1);
        const id = count === 0 ? base : `${base}-${count}`;
        if (heading.id !== id) {
          heading.id = id;
        }
      }
    };
  }, []);

  useEffect(() => {
    assignHeadingIds();
    const root = wrapperRef.current;
    if (!root) return;

    const observer = new MutationObserver(() => {
      assignHeadingIds();
    });

    observer.observe(root, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
    };
  }, [content, assignHeadingIds]);

  return (
    <div
      id="article-content-wrapper"
      ref={wrapperRef}
      className="prose markdown flex flex-col space-y-3 text-theme-primary"
    >
      <StreamingMarkdown
        text={content}
        className="markdown-v2-output"
        worker="/workers/markdown-worker.js"
        mdxCompileMode="worker"
        features={{
          html: true,
          tables: true,
          math: true,
          mdx: true,
          footnotes: true,
          callouts: true,
        }}
      />
    </div>
  );
}
