import React, { useEffect, useMemo, useState } from "react";
import type { MathEngine } from "../types";

interface KaTeXModule {
  renderToString(
    tex: string,
    options?: { displayMode?: boolean; throwOnError?: boolean; [key: string]: unknown },
  ): string;
}

let katexPromise: Promise<KaTeXModule> | null = null;

export async function loadKaTeX(): Promise<KaTeXModule> {
  if (!katexPromise) {
    katexPromise = import("katex").then((mod: unknown) => {
      if (mod && typeof mod === "object" && "default" in mod && mod.default) {
        return mod.default as KaTeXModule;
      }
      return mod as KaTeXModule;
    });
  }
  return katexPromise;
}

export interface KaTeXMathProps {
  tex: string;
  className?: string;
  errorColor?: string;
  fallback?: (tex: string, error?: Error) => React.ReactNode;
  engine?: MathEngine;
}

const MathEngineOutputView: React.FC<{
  engine: MathEngine;
  tex: string;
  displayMode: boolean;
}> = ({ engine, tex, displayMode }) => {
  const output = useMemo(
    () => engine.render(tex, { displayMode }),
    [engine, engine.id, tex, displayMode],
  );
  return <>{output}</>;
};

type MathPreparation =
  | { tex: string; displayMode: boolean; html: string }
  | { tex: string; displayMode: boolean; error: Error };

function useMathPreparation(tex: string, displayMode: boolean, enabled: boolean): MathPreparation | null {
  const [preparation, setPreparation] = useState<MathPreparation | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;

    const prepare = async (): Promise<void> => {
      try {
        const katex = await loadKaTeX();
        const html = katex.renderToString(tex, { displayMode, throwOnError: false });
        if (active) setPreparation({ tex, displayMode, html });
      } catch (reason) {
        if (active) {
          setPreparation({
            tex,
            displayMode,
            error: reason instanceof Error ? reason : new Error(String(reason)),
          });
        }
      }
    };

    void prepare();
    return () => {
      active = false;
    };
  }, [tex, displayMode, enabled]);

  if (preparation?.tex === tex && preparation.displayMode === displayMode) return preparation;
  return null;
}

export const KaTeXInlineMath: React.FC<KaTeXMathProps> = ({ tex, className = "", fallback, engine }) => {
  const preparation = useMathPreparation(tex, false, !engine);
  if (engine) {
    return (
      <span className={`math-inline ${className}`.trim()} data-tex={tex}>
        <MathEngineOutputView engine={engine} tex={tex} displayMode={false} />
      </span>
    );
  }

  if (preparation && "error" in preparation && fallback) {
    return <>{fallback(tex, preparation.error)}</>;
  }

  if (preparation && "html" in preparation) {
    return (
      <span
        className={`math-inline katex-inline ${className}`.trim()}
        data-tex={tex}
        /* biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output is trusted */
        dangerouslySetInnerHTML={{ __html: preparation.html }}
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

export const KaTeXBlockMath: React.FC<KaTeXMathProps> = ({ tex, className = "", fallback, engine }) => {
  const preparation = useMathPreparation(tex, true, !engine);
  if (engine) {
    return (
      <div
        className={`math-display markdown-math-display ${className}`.trim()}
        data-tex={tex}
        style={{ overflowX: "auto" }}
      >
        <MathEngineOutputView engine={engine} tex={tex} displayMode />
      </div>
    );
  }

  if (preparation && "error" in preparation && fallback) {
    return <>{fallback(tex, preparation.error)}</>;
  }

  if (preparation && "html" in preparation) {
    return (
      <div
        className={`math-display katex-block markdown-math-display ${className}`.trim()}
        data-tex={tex}
        style={{ overflowX: "auto" }}
        /* biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output is trusted */
        dangerouslySetInnerHTML={{ __html: preparation.html }}
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

