import React, { useEffect, useState } from "react";

interface KaTeXModule {
  renderToString(
    tex: string,
    options?: { displayMode?: boolean; throwOnError?: boolean; [key: string]: unknown },
  ): string;
}

let katexPromise: Promise<KaTeXModule> | null = null;
let cachedKaTeX: KaTeXModule | null = null;

export async function loadKaTeX(): Promise<KaTeXModule> {
  if (cachedKaTeX) return cachedKaTeX;
  if (!katexPromise) {
    katexPromise = import("katex").then((mod: unknown) => {
      let loaded: KaTeXModule;
      if (mod && typeof mod === "object" && "default" in mod && mod.default) {
        loaded = mod.default as KaTeXModule;
      } else {
        loaded = mod as KaTeXModule;
      }
      cachedKaTeX = loaded;
      return loaded;
    });
  }
  return katexPromise;
}

export interface KaTeXMathProps {
  tex: string;
  className?: string;
  errorColor?: string;
  fallback?: (tex: string, error?: Error) => React.ReactNode;
}

export const KaTeXInlineMath: React.FC<KaTeXMathProps> = ({
  tex,
  className = "",
  fallback,
}) => {
  const [html, setHtml] = useState<string | null>(() => {
    if (cachedKaTeX) {
      try {
        return cachedKaTeX.renderToString(tex, { displayMode: false, throwOnError: false });
      } catch {
        return null;
      }
    }
    if (typeof window === "undefined") {
      try {
        const katexReq = require("katex");
        const loaded = katexReq?.default ?? katexReq;
        if (loaded && typeof loaded.renderToString === "function") {
          cachedKaTeX = loaded;
          return loaded.renderToString(tex, { displayMode: false, throwOnError: false });
        }
      } catch {
        // Fall back to client loading
      }
    }
    return null;
  });
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let mounted = true;
    loadKaTeX()
      .then((katex) => {
        if (!mounted) return;
        try {
          const rendered = katex.renderToString(tex, { displayMode: false, throwOnError: false });
          setHtml(rendered);
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      });

    return () => {
      mounted = false;
    };
  }, [tex]);

  if (error && fallback) {
    return <>{fallback(tex, error)}</>;
  }

  if (html) {
    return (
      <span
        className={`math-inline katex-inline ${className}`.trim()}
        data-tex={tex}
        /* biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output is trusted */
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  // Graceful fallback while loading or on error
  return (
    <span className={`math-inline ${className}`.trim()} data-tex={tex}>
      ${tex}$
    </span>
  );
};

KaTeXInlineMath.displayName = "KaTeXInlineMath";

export const KaTeXBlockMath: React.FC<KaTeXMathProps> = ({
  tex,
  className = "",
  fallback,
}) => {
  const [html, setHtml] = useState<string | null>(() => {
    if (cachedKaTeX) {
      try {
        return cachedKaTeX.renderToString(tex, { displayMode: true, throwOnError: false });
      } catch {
        return null;
      }
    }
    if (typeof window === "undefined") {
      try {
        const katexReq = require("katex");
        const loaded = katexReq?.default ?? katexReq;
        if (loaded && typeof loaded.renderToString === "function") {
          cachedKaTeX = loaded;
          return loaded.renderToString(tex, { displayMode: true, throwOnError: false });
        }
      } catch {
        // Fall back to client loading
      }
    }
    return null;
  });
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let mounted = true;
    loadKaTeX()
      .then((katex) => {
        if (!mounted) return;
        try {
          const rendered = katex.renderToString(tex, { displayMode: true, throwOnError: false });
          setHtml(rendered);
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      });

    return () => {
      mounted = false;
    };
  }, [tex]);

  if (error && fallback) {
    return <>{fallback(tex, error)}</>;
  }

  if (html) {
    return (
      <div
        className={`math-display katex-block markdown-math-display ${className}`.trim()}
        data-tex={tex}
        style={{ overflowX: "auto" }}
        /* biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output is trusted */
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <div
      className={`math-display markdown-math-display ${className}`.trim()}
      data-tex={tex}
      style={{ overflowX: "auto" }}
    >
      <span className="math-display-content">$${tex}$$</span>
    </div>
  );
};

KaTeXBlockMath.displayName = "KaTeXBlockMath";
