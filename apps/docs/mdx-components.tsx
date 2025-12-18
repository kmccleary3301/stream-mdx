import type { MDXComponents } from "mdx/types";

import Preview from "@/components/preview";
import { ScrollAreaHorizontal } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import React from "react";

export const PreviewExample: React.FC = () => (
  <div className="min- flex h-10 w-32 items-center justify-center rounded-lg border border-yellow-6 bg-yellow-3 text-yellow-11">
    <div className="overflow-x-auto">
      <div className="min-w-full">
        <div className="min-w-full">
          <div className="min-w-full">Showcase</div>
        </div>
      </div>
    </div>
  </div>
);

const YouTube: React.FC<{ videoId: string; caption?: string; className?: string }> = ({ videoId, caption, className }) => {
  return (
    <div className={["w-full", className].filter(Boolean).join(" ")}>
      <div className="overflow-hidden rounded-large border border-border">
        <iframe
          title={caption ?? "YouTube"}
          src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}`}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          loading="lazy"
          style={{ width: "100%", aspectRatio: "16 / 9", border: 0 }}
        />
      </div>
      {caption ? <sub className="mt-2 block text-center text-muted">{caption}</sub> : null}
    </div>
  );
};

const Image: React.FC<{ src: string; alt?: string; caption?: string; className?: string }> = ({ src, alt, caption, className }) => {
  return (
    <figure className={["my-6", className].filter(Boolean).join(" ")}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt ?? ""} className="w-full rounded-large border border-border" />
      {caption ? <figcaption className="mt-2 text-center text-muted text-sm">{caption}</figcaption> : null}
    </figure>
  );
};

function extractLanguage(className: unknown): string | undefined {
  if (typeof className !== "string") return undefined;
  const token = className
    .split(/\s+/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("language-"));
  if (!token) return undefined;
  const lang = token.slice("language-".length).trim();
  return lang || undefined;
}

function extractCodeText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value.join("");
  }
  return undefined;
}

export const components: MDXComponents = {
  PreviewExample,
  Preview: ({ children, codeblock }) => {
    return (
      <Preview codeblock={codeblock ? "true" : undefined}>
        {children}
      </Preview>
    );
  },
  YouTube,
  Image,
  pre: ({ children, className, ...props }) => {
    const maybeCode = React.Children.toArray(children).find(
      (child) => React.isValidElement(child) && child.type === "code",
    ) as React.ReactElement<{ className?: string; children?: unknown }> | undefined;

    const codeText = maybeCode ? extractCodeText(maybeCode.props.children) : undefined;

    if (!maybeCode || codeText === undefined) {
      return (
        <pre className={cn("mdx-pre", className)} {...props}>
          {children}
        </pre>
      );
    }

    const lang = extractLanguage(maybeCode.props.className);
    const trimmed = codeText.endsWith("\n") ? codeText.slice(0, -1) : codeText;

    return (
      <pre className={cn("not-prose my-3 flex flex-col rounded-lg border border-input pt-1 font-mono text-sm", className)}>
        <ScrollAreaHorizontal className="min-w-auto">
          <pre className="min-w-max font-mono p-[16px]">
            <code className={lang ? `language-${lang}` : undefined}>{trimmed}</code>
          </pre>
        </ScrollAreaHorizontal>
      </pre>
    );
  },
};
