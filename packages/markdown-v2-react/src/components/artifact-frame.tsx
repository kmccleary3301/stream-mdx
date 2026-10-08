import React, { useEffect, useId, useRef, useState } from "react";
import type { CodeFenceRendererProps } from "../types";

export interface ArtifactCspConfig {
  scriptSrc?: string[];
  styleSrc?: string[];
  imgSrc?: string[];
  fontSrc?: string[];
  connectSrc?: string[];
}

export interface ArtifactFrameProps extends CodeFenceRendererProps {
  csp?: ArtifactCspConfig;
  themeCssVars?: Record<string, string>;
  maxHeight?: number | string;
  onLinkClick?: (href: string, target?: string) => void;
  className?: string;
  style?: React.CSSProperties;
}

const DEFAULT_CSP: Required<ArtifactCspConfig> = {
  scriptSrc: ["'unsafe-inline'"],
  styleSrc: ["'unsafe-inline'"],
  imgSrc: ["data:", "blob:"],
  fontSrc: ["data:"],
  connectSrc: ["'none'"],
};
function formatDirective(defaultEntries: string[], userEntries?: string[]): string {
  if (!userEntries || userEntries.length === 0) {
    return defaultEntries.join(" ");
  }
  const set = new Set([...defaultEntries, ...userEntries]);
  return Array.from(set).join(" ");
}

const ARTIFACT_LINK_PROTOCOLS: Record<string, true> = { "http:": true, "https:": true, "mailto:": true };

/** Only absolute http(s)/mailto URLs leave the sandbox; everything else (javascript:, data:, blob:) is dropped. */
function toSafeArtifactHref(href: string): string | null {
  try {
    const url = new URL(href);
    return ARTIFACT_LINK_PROTOCOLS[url.protocol] ? url.href : null;
  } catch {
    return null;
  }
}

export function buildArtifactSrcDoc(options: {
  html: string;
  csp?: ArtifactCspConfig;
  themeCssVars?: Record<string, string>;
}): string {
  const scriptList = formatDirective(DEFAULT_CSP.scriptSrc, options.csp?.scriptSrc);
  const styleList = formatDirective(DEFAULT_CSP.styleSrc, options.csp?.styleSrc);
  const imgList = formatDirective(DEFAULT_CSP.imgSrc, options.csp?.imgSrc);
  const fontList = formatDirective(DEFAULT_CSP.fontSrc, options.csp?.fontSrc);
  const connectList = options.csp?.connectSrc?.length
    ? options.csp.connectSrc.join(" ")
    : "'none'";
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${scriptList}; style-src ${styleList}; img-src ${imgList}; font-src ${fontList}; connect-src ${connectList}; base-uri 'none'; form-action 'none';">`;

  let themeStyles = "";
  if (options.themeCssVars && Object.keys(options.themeCssVars).length > 0) {
    const vars = Object.entries(options.themeCssVars)
      .map(([k, v]) => `${k.startsWith("--") ? k : `--${k}`}: ${v};`)
      .join(" ");
    themeStyles = `<style id="stream-mdx-artifact-theme">:root { ${vars} }</style>`;
  }

  const bootstrapScript = `
<script>
(() => {
  function postSize() {
    try {
      var height = Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      );
      window.parent.postMessage({ type: 'stream-mdx:artifact-size', height: height }, '*');
    } catch (_) {}
  }

  window.addEventListener('load', postSize);
  window.addEventListener('resize', postSize);
  // The bootstrap runs in <head>, before <body> exists.
  document.addEventListener('DOMContentLoaded', function() {
    postSize();
    if (typeof ResizeObserver !== 'undefined' && document.body) {
      new ResizeObserver(postSize).observe(document.body);
    }
  });
  setTimeout(postSize, 50);
  setTimeout(postSize, 300);

  document.addEventListener('click', function(e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (a && a.href) {
      e.preventDefault();
      window.parent.postMessage({
        type: 'stream-mdx:artifact-link',
        href: a.href,
        target: a.getAttribute('target') || '_self'
      }, '*');
    }
  });
})();
</script>`;

  // The policy and bootstrap always precede artifact content, so no artifact markup (including a
  // full document with its own <!doctype>/<html>/<head>) can run before the CSP applies. The HTML
  // parser ignores the artifact's duplicate <html>/<head> tags and keeps their contents.
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${cspMeta}
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body {
  margin: 0;
  padding: 12px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  box-sizing: border-box;
  color: var(--foreground, #111827);
  background-color: transparent;
}
</style>
${themeStyles}
${bootstrapScript}
${options.html}`;
}

export const ArtifactFrame: React.FC<ArtifactFrameProps> = ({
  code,
  language,
  isFinalized,
  renderCode,
  csp,
  themeCssVars,
  maxHeight = 600,
  onLinkClick,
  openLink,
  className = "",
  style,
}) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [frameHeight, setFrameHeight] = useState<number | null>(null);
  const frameId = useId();

  useEffect(() => {
    if (!isFinalized) return;

    const handleMessage = (event: MessageEvent) => {
      // Security check: validate that the event source strictly matches our iframe's contentWindow
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }

      const data = event.data;
      if (!data || typeof data !== "object") return;

      if (data.type === "stream-mdx:artifact-size" && typeof data.height === "number") {
        setFrameHeight(Math.max(50, data.height));
      } else if (data.type === "stream-mdx:artifact-link" && typeof data.href === "string") {
        const href = toSafeArtifactHref(data.href);
        if (!href) return;
        const target = typeof data.target === "string" ? data.target : undefined;
        if (onLinkClick) {
          onLinkClick(href, target);
        } else if (openLink) {
          openLink(href);
        } else {
          window.open(href, "_blank", "noopener,noreferrer");
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [isFinalized, onLinkClick, openLink]);

  // While not finalized: show the code view
  if (!isFinalized) {
    return <>{renderCode}</>;
  }

  const srcDoc = buildArtifactSrcDoc({
    html: code,
    csp,
    themeCssVars,
  });

  const parsedMaxHeight = typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight;

  return (
    <div
      className={`stream-mdx-artifact-wrapper my-4 w-full rounded-md border border-border bg-background overflow-hidden ${className}`.trim()}
      style={{
        maxHeight: parsedMaxHeight,
        overflowY: "auto",
        overflowX: "hidden",
        ...style,
      }}
    >
      <iframe
        ref={iframeRef}
        id={frameId}
        title={`Artifact ${language || "html"}`}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        className="w-full border-0 block"
        style={{
          width: "100%",
          height: frameHeight != null ? `${frameHeight}px` : "200px",
          minHeight: "80px",
          maxHeight: "none",
          border: "none",
          display: "block",
        }}
      />
    </div>
  );
};

ArtifactFrame.displayName = "ArtifactFrame";
