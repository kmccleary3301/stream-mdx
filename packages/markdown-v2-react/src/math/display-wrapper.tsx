import type React from "react";

interface DisplayMathWrapperProps {
  children: React.ReactNode;
  className?: string;
}

const BASE_CLASS = "katex-block-wrapper my-2";
const SCROLL_ROOT_CLASS = "katex-scroll relative overflow-x-hidden w-full max-w-full";
const VIEWPORT_CLASS = "katex-scroll-viewport h-full w-full rounded-[inherit]";
const SHIM_STYLE: React.CSSProperties = { minWidth: "100%", display: "table" };
const VIEWPORT_STYLE: React.CSSProperties = {
  overflowX: "auto",
  overflowY: "hidden",
  WebkitOverflowScrolling: "touch",
};

function combineClassNames(base: string, extra?: string): string {
  return extra && extra.length > 0 ? `${base} ${extra}` : base;
}

export function DisplayMathWrapper({ children, className = "" }: DisplayMathWrapperProps): JSX.Element {
  const wrapperClass = combineClassNames(BASE_CLASS, className);

  return (
    <div className={wrapperClass}>
      <div dir="ltr" className={SCROLL_ROOT_CLASS}>
        <div className={VIEWPORT_CLASS} style={VIEWPORT_STYLE}>
          <div style={SHIM_STYLE}>{children}</div>
        </div>
      </div>
    </div>
  );
}

export function renderDisplayMathWithHtml(html: string, className?: string): JSX.Element {
  return (
    <DisplayMathWrapper className={className}>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: HTML produced by trusted KaTeX renderer */}
      <div className="katex-block" dangerouslySetInnerHTML={{ __html: html }} />
    </DisplayMathWrapper>
  );
}
