import React from "react";

type MermaidModule = {
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

let mermaidPromise: Promise<MermaidModule> | null = null;
let mermaidInitialized = false;
let mermaidIdCounter = 0;

async function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => ((mod as unknown as { default?: MermaidModule }).default ?? (mod as unknown as MermaidModule)) as MermaidModule);
  }
  const mermaid = await mermaidPromise;
  if (!mermaidInitialized && typeof mermaid.initialize === "function") {
    mermaid.initialize({ startOnLoad: false });
    mermaidInitialized = true;
  }
  return mermaid;
}

function nextMermaidId(): string {
  mermaidIdCounter += 1;
  return `stream-mdx-mermaid-${mermaidIdCounter}`;
}

export type MermaidBlockProps = {
  code: string;
  renderCode: React.ReactNode;
  meta?: Record<string, unknown>;
  isFinalized?: boolean;
  defaultView?: "diagram" | "code";
  debounceMs?: number;
};

export const MermaidBlock: React.FC<MermaidBlockProps> = ({ code, renderCode, defaultView = "diagram", debounceMs = 200 }) => {
  const [view, setView] = React.useState<"diagram" | "code">(defaultView);
  const [svg, setSvg] = React.useState<string>("");
  const [error, setError] = React.useState<string | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const bindRef = React.useRef<((element: Element) => void) | undefined>(undefined);
  const lastValidSvgRef = React.useRef<string>("");
  const generationRef = React.useRef(0);

  React.useEffect(() => {
    setView(defaultView);
  }, [defaultView]);

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

    const timeout = setTimeout(async () => {
      try {
        const mermaid = await loadMermaid();
        if (typeof mermaid.render !== "function") {
          throw new Error("Mermaid runtime missing render()");
        }
        const result = await mermaid.render(nextMermaidId(), trimmed);
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
    }, Math.max(0, debounceMs));

    return () => clearTimeout(timeout);
  }, [code, debounceMs, view]);

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

  const toolbarStyle: React.CSSProperties = {
    display: "flex",
    gap: 8,
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 10px",
    borderBottom: "1px solid rgba(0,0,0,0.08)",
  };

  const wrapperStyle: React.CSSProperties = {
    border: "1px solid rgba(0,0,0,0.12)",
    borderRadius: 10,
    overflow: "hidden",
    margin: "12px 0",
  };

  const buttonStyle = (active: boolean): React.CSSProperties => ({
    border: "1px solid rgba(0,0,0,0.18)",
    borderRadius: 8,
    padding: "3px 8px",
    fontSize: 12,
    background: active ? "rgba(0,0,0,0.06)" : "transparent",
    cursor: "pointer",
  });

  const toolbar = (
    <div style={toolbarStyle} className="stream-mdx-mermaid-toolbar">
      <span style={{ fontSize: 12, opacity: 0.8 }}>mermaid</span>
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" onClick={() => setView("diagram")} style={buttonStyle(view === "diagram")}>
          Diagram
        </button>
        <button type="button" onClick={() => setView("code")} style={buttonStyle(view === "code")}>
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

  return (
    <div style={wrapperStyle} className="stream-mdx-mermaid-block">
      {toolbar}
      {error ? (
        <div style={{ fontSize: 12, padding: "6px 10px", opacity: 0.8 }} className="stream-mdx-mermaid-error">
          {error}
        </div>
      ) : null}
      {svg ? (
        <div
          ref={containerRef}
          className="stream-mdx-mermaid-diagram"
          style={{ overflowX: "auto", padding: 10 }}
          /* biome-ignore lint/security/noDangerouslySetInnerHtml: SVG is produced by mermaid */
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div style={{ fontSize: 12, padding: "10px", opacity: 0.7 }} className="stream-mdx-mermaid-placeholder">
          Waiting for a valid diagram…
        </div>
      )}
    </div>
  );
};

