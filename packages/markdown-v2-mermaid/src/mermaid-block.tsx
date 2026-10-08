import type { CSSProperties, ComponentType, FC, ReactNode } from "react";
import React from "react";

export type MermaidModule = {
  initialize?: (config: Record<string, unknown>) => void;
  render?: (
    id: string,
    code: string,
  ) => Promise<
    | string
    | {
        svg?: string;
        bindFunctions?: (element: Element) => void;
      }
  >;
};

export type MermaidConfig = Record<string, unknown>;

export type MermaidErrorComponentProps = {
  error: string;
  code: string;
  retry: () => void;
  chart?: string;
};

export type CreateMermaidBlockOptions = {
  config?: MermaidConfig;
  errorComponent?: ComponentType<MermaidErrorComponentProps>;
  defaultView?: "diagram" | "code";
  debounceMs?: number;
};

export type MermaidBlockProps = {
  code: string;
  renderCode: ReactNode;
  meta?: Record<string, unknown>;
  isFinalized?: boolean;
  language: string;
  info?: string;
  blockId?: string;
  defaultView?: "diagram" | "code";
  debounceMs?: number;
};

export interface MermaidBlockComponent extends FC<MermaidBlockProps> {
  defer?: boolean;
}

type MermaidExport = MermaidModule & { default?: MermaidModule };

type GlobalWithMermaidMock = typeof globalThis & {
  __STREAM_MDX_MERMAID_MOCK__?: MermaidModule;
};

let mermaidPromise: Promise<MermaidModule> | null = null;
let customMermaidModule: MermaidModule | null = null;
let mermaidIdCounter = 0;
let renderQueue: Promise<unknown> = Promise.resolve();

export function __setMermaidModuleForTesting(mock: MermaidModule | null): void {
  customMermaidModule = mock;
  mermaidPromise = mock ? Promise.resolve(mock) : null;
}

async function loadMermaid(): Promise<MermaidModule> {
  if (customMermaidModule) {
    return customMermaidModule;
  }
  const globalScope = globalThis as GlobalWithMermaidMock;
  const globalMock = globalScope.__STREAM_MDX_MERMAID_MOCK__;
  if (globalMock) {
    return globalMock;
  }
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod: MermaidExport) => mod.default ?? mod);
  }
  return mermaidPromise;
}

function cleanupLeakedErrorElement(id: string): void {
  if (typeof document !== "undefined") {
    const el =
      document.getElementById(id) ??
      document.getElementById(`d${id}`) ??
      document.getElementById(`mermaid-${id}`);
    if (el && el.parentNode === document.body) {
      el.remove();
    }
  }
}

function enqueueRender<T>(task: () => Promise<T>): Promise<T> {
  const result = renderQueue.then(
    () => task(),
    () => task(),
  );
  renderQueue = result.then(
    () => {},
    () => {},
  );
  return result;
}

export function createMermaidBlock(options: CreateMermaidBlockOptions = {}): MermaidBlockComponent {
  const MermaidBlockInstance: MermaidBlockComponent = ({
    code,
    renderCode,
    defaultView = options.defaultView ?? "diagram",
    debounceMs = options.debounceMs ?? 200,
  }) => {
    const [view, setView] = React.useState<"diagram" | "code">(defaultView);
    const [svg, setSvg] = React.useState<string>("");
    const [error, setError] = React.useState<string | null>(null);
    const [retryNonce, setRetryNonce] = React.useState(0);
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const bindRef = React.useRef<((element: Element) => void) | undefined>(undefined);
    const lastValidSvgRef = React.useRef<string>("");
    const generationRef = React.useRef(0);
    const retryRef = React.useRef(false);

    React.useEffect(() => {
      setView(defaultView);
    }, [defaultView]);

    const retry = React.useCallback(() => {
      setView("diagram");
      setError(null);
      retryRef.current = true;
      setRetryNonce((n) => n + 1);
    }, []);

    React.useEffect(() => {
      if (view !== "diagram") return;

      const trimmed = typeof code === "string" ? code.trim() : "";
      if (!trimmed) {
        setError(null);
        setSvg("");
        lastValidSvgRef.current = "";
        return;
      }

      generationRef.current += 1;
      const generation = generationRef.current;
      const isRetry = retryRef.current;
      retryRef.current = false;
      const delay = isRetry ? 0 : Math.max(0, debounceMs);

      const timeout = setTimeout(async () => {
        try {
          const result = await enqueueRender(async () => {
            const mermaid = await loadMermaid();
            if (typeof mermaid.initialize === "function") {
              mermaid.initialize({
                securityLevel: "strict",
                ...options.config,
                startOnLoad: false,
                suppressErrorRendering: true,
              });
            }
            if (typeof mermaid.render !== "function") {
              throw new Error("Mermaid runtime missing render()");
            }
            mermaidIdCounter += 1;
            const id = `stream-mdx-mermaid-${mermaidIdCounter}`;
            try {
              return await mermaid.render(id, trimmed);
            } finally {
              cleanupLeakedErrorElement(id);
            }
          });

          if (generation !== generationRef.current) return;

          const svgText = typeof result === "string" ? result : (result?.svg ?? "");
          const bindFunctions = typeof result === "string" ? undefined : result?.bindFunctions;
          if (!svgText || svgText.trim().length === 0) {
            throw new Error("Mermaid render returned empty SVG");
          }

          lastValidSvgRef.current = svgText;
          bindRef.current = typeof bindFunctions === "function" ? bindFunctions : undefined;
          setSvg(svgText);
          setError(null);
        } catch (err) {
          if (generation !== generationRef.current) return;
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          if (lastValidSvgRef.current) {
            setSvg(lastValidSvgRef.current);
          }
        }
      }, delay);

      return () => clearTimeout(timeout);
    }, [code, debounceMs, view, retryNonce]);

    React.useEffect(() => {
      if (view !== "diagram") return;
      if (!svg) return;
      const bind = bindRef.current;
      const el = containerRef.current;
      if (!el || typeof bind !== "function") return;
      try {
        bind(el);
      } catch {
        // ignore bind errors
      }
    }, [svg, view]);

    const toolbarStyle: CSSProperties = {
      display: "flex",
      gap: 8,
      alignItems: "center",
      justifyContent: "space-between",
      padding: "6px 10px",
      borderBottom: "1px solid rgba(0,0,0,0.08)",
    };

    const wrapperStyle: CSSProperties = {
      border: "1px solid rgba(0,0,0,0.12)",
      borderRadius: 10,
      overflow: "hidden",
      margin: "12px 0",
    };

    const toolbar = (
      <div style={toolbarStyle} className="stream-mdx-mermaid-toolbar">
        <span style={{ fontSize: 12, opacity: 0.8 }}>mermaid</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            onClick={() => setView("diagram")}
            style={{
              border: "1px solid rgba(0,0,0,0.18)",
              borderRadius: 8,
              padding: "3px 8px",
              fontSize: 12,
              background: view === "diagram" ? "rgba(0,0,0,0.06)" : "transparent",
              cursor: "pointer",
            }}
          >
            Diagram
          </button>
          <button
            type="button"
            onClick={() => setView("code")}
            style={{
              border: "1px solid rgba(0,0,0,0.18)",
              borderRadius: 8,
              padding: "3px 8px",
              fontSize: 12,
              background: view === "code" ? "rgba(0,0,0,0.06)" : "transparent",
              cursor: "pointer",
            }}
          >
            Code
          </button>
        </div>
      </div>
    );

    if (view === "code") {
      return (
        <div style={wrapperStyle} className="stream-mdx-mermaid-block">
          {toolbar}
          {renderCode}
        </div>
      );
    }

    const ErrorComponent = options.errorComponent;

    return (
      <div style={wrapperStyle} className="stream-mdx-mermaid-block">
        {toolbar}
        {error ? (
          ErrorComponent ? (
            <ErrorComponent error={error} code={code} chart={code} retry={retry} />
          ) : (
            <div style={{ fontSize: 12, padding: "6px 10px", opacity: 0.8 }} className="stream-mdx-mermaid-error">
              {error}
            </div>
          )
        ) : null}
        {svg ? (
          <div
            ref={containerRef}
            className="stream-mdx-mermaid-diagram"
            style={{ overflowX: "auto", padding: 10 }}
            /* biome-ignore lint/security/noDangerouslySetInnerHtml: SVG is produced by mermaid */
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : !error || !ErrorComponent ? (
          <div style={{ fontSize: 12, padding: "10px", opacity: 0.7 }} className="stream-mdx-mermaid-placeholder">
            Waiting for a valid diagram…
          </div>
        ) : null}
      </div>
    );
  };

  MermaidBlockInstance.displayName = "MermaidBlock";
  MermaidBlockInstance.defer = true;
  return MermaidBlockInstance;
}

export const MermaidBlock: MermaidBlockComponent = createMermaidBlock();
