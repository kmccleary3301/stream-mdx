import React, { createContext, useContext, useEffect, useRef, useState } from "react";

interface KaTeXModule {
  renderToString(
    tex: string,
    options?: { displayMode?: boolean; throwOnError?: boolean; trust?: boolean; maxExpand?: number; macros?: Record<string, unknown>; [key: string]: unknown },
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

type MathPreparation =
  | { tex: string; displayMode: boolean; scope: DocumentMathMacroScope | null; html: string }
  | { tex: string; displayMode: boolean; scope: DocumentMathMacroScope | null; error: Error };

type MathScopeEntry = {
  element: HTMLElement;
  tex: string;
  displayMode: boolean;
  complete: boolean;
  publish: (preparation: MathPreparation | null) => void;
};

const DOCUMENT_POSITION_PRECEDING = 2;
const DOCUMENT_POSITION_FOLLOWING = 4;

export class DocumentMathMacroScope {
  private readonly entries = new Set<MathScopeEntry>();
  private orderedEntries: MathScopeEntry[] = [];
  private macroSnapshots: Array<Record<string, unknown>> = [];
  private katex: KaTeXModule | null = null;
  private loadError: Error | null = null;
  private loading = false;
  private disposed = false;

  register(
    element: HTMLElement,
    tex: string,
    displayMode: boolean,
    complete: boolean,
    publish: (preparation: MathPreparation | null) => void,
  ): () => void {
    const entry = { element, tex, displayMode, complete, publish };
    this.entries.add(entry);
    this.refresh();
    return () => {
      if (this.entries.delete(entry)) this.refresh();
    };
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    this.orderedEntries = [];
    this.macroSnapshots = [];
  }

  private refresh(): void {
    if (this.disposed) return;
    if (this.loadError) {
      for (const entry of this.entries) {
        entry.publish({ tex: entry.tex, displayMode: entry.displayMode, scope: this, error: this.loadError });
      }
      return;
    }
    if (this.katex) {
      this.recompute(this.katex);
      return;
    }
    if (this.loading) return;
    this.loading = true;
    void loadKaTeX().then((katex) => {
      if (this.disposed) return;
      this.katex = katex;
      this.refresh();
    }).catch((reason: unknown) => {
      if (this.disposed) return;
      this.loadError = reason instanceof Error ? reason : new Error(String(reason));
      for (const entry of this.entries) {
        entry.publish({ tex: entry.tex, displayMode: entry.displayMode, scope: this, error: this.loadError });
      }
    }).finally(() => {
      this.loading = false;
    });
  }

  private recompute(katex: KaTeXModule): void {
    const nextEntries = [...this.entries].sort((left, right) => {
      const position = left.element.compareDocumentPosition(right.element);
      if (position & DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    let unchangedPrefix = 0;
    while (
      unchangedPrefix < this.orderedEntries.length &&
      unchangedPrefix < nextEntries.length &&
      this.orderedEntries[unchangedPrefix] === nextEntries[unchangedPrefix]
    ) {
      unchangedPrefix += 1;
    }
    let macros = unchangedPrefix > 0 ? { ...this.macroSnapshots[unchangedPrefix - 1] } : {};
    this.orderedEntries = nextEntries;
    this.macroSnapshots.length = unchangedPrefix;
    for (let index = unchangedPrefix; index < nextEntries.length; index += 1) {
      const entry = nextEntries[index];
      let preparation: MathPreparation | null = null;
      if (entry.complete) {
        const nextMacros = { ...macros };
        try {
          const html = katex.renderToString(entry.tex, {
            displayMode: entry.displayMode,
            throwOnError: false,
            trust: false,
            maxExpand: 1000,
            macros: nextMacros,
          });
          macros = nextMacros;
          preparation = { tex: entry.tex, displayMode: entry.displayMode, scope: this, html };
        } catch (reason) {
          preparation = {
            tex: entry.tex,
            displayMode: entry.displayMode,
            scope: this,
            error: reason instanceof Error ? reason : new Error(String(reason)),
          };
        }
      }
      this.macroSnapshots[index] = { ...macros };
      entry.publish(preparation);
    }
  }
}

export const DocumentMathMacroScopeContext = createContext<DocumentMathMacroScope | null>(null);
export const MathExpressionCompletenessContext = createContext(true);

export interface KaTeXMathProps {
  tex: string;
  className?: string;
  errorColor?: string;
  fallback?: (tex: string, error?: Error) => React.ReactNode;
}

function useMathPreparation<T extends HTMLElement>(
  tex: string,
  displayMode: boolean,
  elementRef: React.RefObject<T | null>,
): MathPreparation | null {
  const scope = useContext(DocumentMathMacroScopeContext);
  const complete = useContext(MathExpressionCompletenessContext);
  const [preparation, setPreparation] = useState<MathPreparation | null>(null);

  useEffect(() => {
    let active = true;
    if (scope) {
      const element = elementRef.current;
      if (!element) return () => { active = false; };
      return scope.register(element, tex, displayMode, complete, (result) => {
        if (active) setPreparation(result);
      });
    }

    const prepare = async (): Promise<void> => {
      try {
        const katex = await loadKaTeX();
        const html = katex.renderToString(tex, {
          displayMode,
          throwOnError: false,
          trust: false,
          maxExpand: 1000,
        });
        if (active) setPreparation({ tex, displayMode, scope: null, html });
      } catch (reason) {
        if (active) {
          setPreparation({
            tex,
            displayMode,
            scope: null,
            error: reason instanceof Error ? reason : new Error(String(reason)),
          });
        }
      }
    };

    void prepare();
    return () => {
      active = false;
    };
  }, [tex, displayMode, scope, complete, elementRef]);

  if (scope && !complete) return null;
  if (preparation?.tex === tex && preparation.displayMode === displayMode && preparation.scope === scope) return preparation;
  return null;
}

export const KaTeXInlineMath: React.FC<KaTeXMathProps> = ({ tex, className = "", fallback }) => {
  const elementRef = useRef<HTMLSpanElement | null>(null);
  const preparation = useMathPreparation(tex, false, elementRef);

  if (preparation && "error" in preparation && fallback) {
    return <>{fallback(tex, preparation.error)}</>;
  }

  if (preparation && "html" in preparation) {
    return (
      <span
        ref={elementRef}
        className={`math-inline katex-inline ${className}`.trim()}
        data-tex={tex}
        /* biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output is trusted */
        dangerouslySetInnerHTML={{ __html: preparation.html }}
      />
    );
  }

  // Graceful fallback while loading or on error
  return (
    <span ref={elementRef} className={`math-inline ${className}`.trim()} data-tex={tex}>
      ${tex}$
    </span>
  );
};

KaTeXInlineMath.displayName = "KaTeXInlineMath";

export const KaTeXBlockMath: React.FC<KaTeXMathProps> = ({ tex, className = "", fallback }) => {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const preparation = useMathPreparation(tex, true, elementRef);

  if (preparation && "error" in preparation && fallback) {
    return <>{fallback(tex, preparation.error)}</>;
  }

  if (preparation && "html" in preparation) {
    return (
      <div
        ref={elementRef}
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
      ref={elementRef}
      className={`math-display markdown-math-display ${className}`.trim()}
      data-tex={tex}
      style={{ overflowX: "auto" }}
    >
      <span className="math-display-content">$${tex}$$</span>
    </div>
  );
};

KaTeXBlockMath.displayName = "KaTeXBlockMath";

