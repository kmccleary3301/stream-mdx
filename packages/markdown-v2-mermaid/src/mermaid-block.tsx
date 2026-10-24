import type { CSSProperties, ComponentType, FC, ReactNode } from "react";
import React from "react";
import type { MermaidEngine } from "@stream-mdx/react";

type MermaidBindingResult = void | (() => void);
type MermaidBinding = (element: Element) => MermaidBindingResult;

export type MermaidModule = {
  initialize?: (config: Record<string, unknown>) => void;
  render?: (
    id: string,
    code: string,
  ) => Promise<
    | string
    | {
        svg?: string;
        bindFunctions?: MermaidBinding;
      }
  >;
};

export type MermaidModuleLoader = MermaidModule | (() => Promise<MermaidModule>);

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
  mermaid?: MermaidModuleLoader;
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
  controls?: {
    copy?: boolean;
    download?: boolean;
    fullscreen?: boolean;
  };
  copy?: () => Promise<boolean>;
  download?: () => void;
};
export interface MermaidBlockComponent extends FC<MermaidBlockProps> {
  defer?: boolean;
}

type MermaidExport = MermaidModule & { default?: MermaidModule };
type MermaidRenderOwner = {
  code: string;
  blockId?: string;
  config: MermaidConfig | undefined;
  provider: MermaidModuleLoader | undefined;
  factory: CreateMermaidBlockOptions;
};

type MermaidArtifact = MermaidRenderOwner & {
  svg: string;
  bindFunctions?: MermaidBinding;
};

type MermaidRenderError = MermaidRenderOwner & {
  message: string;
};

const obsoleteRender = Symbol("obsolete Mermaid render");

let defaultMermaidPromise: Promise<MermaidModule> | null = null;
let mermaidIdCounter = 0;
let renderQueue: Promise<unknown> = Promise.resolve();

async function loadDefaultMermaid(): Promise<MermaidModule> {
  if (!defaultMermaidPromise) {
    defaultMermaidPromise = import("mermaid").then(
      (mod: MermaidExport) => mod.default ?? mod,
    );
  }
  return defaultMermaidPromise;
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
  const resolveMermaid = async (): Promise<MermaidModule> => {
    const provider = options.mermaid;
    if (provider) {
      if (typeof provider === "function") {
        return await provider();
      }
      return provider;
    }
    return await loadDefaultMermaid();
  };

  const MermaidBlockInstance: MermaidBlockComponent = (props) => {
    const {
      code,
      renderCode,
      blockId,
      defaultView = options.defaultView ?? "diagram",
      debounceMs = options.debounceMs ?? 200,
      controls,
      copy,
    } = props;
    const [view, setView] = React.useState<"diagram" | "code">(defaultView);
    const [artifact, setArtifact] = React.useState<MermaidArtifact | null>(null);
    const [error, setError] = React.useState<MermaidRenderError | null>(null);
    const [retryNonce, setRetryNonce] = React.useState(0);
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const generationRef = React.useRef(0);
    const retryRef = React.useRef(false);

    React.useEffect(() => {
      setView(defaultView);
    }, [defaultView]);

    const [copied, setCopied] = React.useState(false);
    const handleCopy = React.useCallback(async () => {
      if (copy) {
        const success = await copy();
        if (success) {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }
      }
    }, [copy]);

    const retry = React.useCallback(() => {
      setView("diagram");
      setError(null);
      retryRef.current = true;
      setRetryNonce((n) => n + 1);
    }, []);

    React.useEffect(() => {
      generationRef.current += 1;
      const generation = generationRef.current;
      let active = true;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const isCurrent = () => active && generationRef.current === generation;
      const trimmed = typeof code === "string" ? code.trim() : "";

      if (view !== "diagram") {
        return () => {
          active = false;
        };
      }

      if (!trimmed) {
        setError(null);
        setArtifact(null);
        return () => {
          active = false;
        };
      }

      const isRetry = retryRef.current;
      retryRef.current = false;
      const delay = isRetry ? 0 : Math.max(0, debounceMs);

      timeout = setTimeout(async () => {
        try {
          const result = await enqueueRender(async () => {
            if (!isCurrent()) return obsoleteRender;

            const mermaid = await resolveMermaid();
            if (!isCurrent()) return obsoleteRender;

            if (typeof mermaid.initialize === "function") {
              if (!isCurrent()) return obsoleteRender;
              mermaid.initialize({
                securityLevel: "strict",
                ...options.config,
                startOnLoad: false,
                suppressErrorRendering: true,
              });
            }

            if (!isCurrent()) return obsoleteRender;
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

          if (!isCurrent() || result === obsoleteRender) return;

          const svgText = typeof result === "string" ? result : (result?.svg ?? "");
          const bindFunctions = typeof result === "string" ? undefined : result?.bindFunctions;
          if (!svgText || svgText.trim().length === 0) {
            throw new Error("Mermaid render returned empty SVG");
          }

          setArtifact({
            code,
            blockId,
            config: options.config,
            provider: options.mermaid,
            factory: options,
            svg: svgText,
            bindFunctions: typeof bindFunctions === "function" ? bindFunctions : undefined,
          });
          setError(null);
        } catch (err) {
          if (!isCurrent()) return;
          setError({
            code,
            blockId,
            config: options.config,
            provider: options.mermaid,
            factory: options,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }, delay);

      return () => {
        active = false;
        if (timeout !== undefined) clearTimeout(timeout);
      };
    }, [blockId, code, debounceMs, options.config, options.mermaid, retryNonce, view]);

    React.useEffect(() => {
      if (view !== "diagram" || !artifact) return;
      const bind = artifact.bindFunctions;
      const el = containerRef.current;
      if (!el || typeof bind !== "function") return;

      let dispose: (() => void) | undefined;
      try {
        const result = bind(el);
        if (typeof result === "function") dispose = result;
      } catch {
        // ignore bind errors
      }
      return () => dispose?.();
    }, [artifact, view]);

    const currentError =
      error &&
      error.code === code &&
      error.blockId === blockId &&
      error.config === options.config &&
      error.provider === options.mermaid &&
      error.factory === options
        ? error.message
        : null;
    const isPreviousArtifact =
      artifact !== null &&
      (artifact.code !== code ||
        artifact.blockId !== blockId ||
        artifact.config !== options.config ||
        artifact.provider !== options.mermaid ||
        artifact.factory !== options);

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
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
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
          {copy && controls?.copy ? (
            <button
              type="button"
              className="stream-mdx-control stream-mdx-control-copy stream-mdx-control-mermaid-copy"
              data-stream-mdx-control="copy"
              data-stream-mdx-target="mermaid"
              data-stream-mdx-action="copy"
              aria-label={copied ? "Copied!" : "Copy diagram code"}
              onClick={handleCopy}
              style={{
                border: "1px solid rgba(0,0,0,0.18)",
                borderRadius: 8,
                padding: "3px 8px",
                fontSize: 12,
                background: "transparent",
                cursor: "pointer",
              }}
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          ) : null}
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
        {currentError ? (
          ErrorComponent ? (
            <ErrorComponent error={currentError} code={code} chart={code} retry={retry} />
          ) : (
            <div style={{ fontSize: 12, padding: "6px 10px", opacity: 0.8 }} className="stream-mdx-mermaid-error">
              {currentError}
            </div>
          )
        ) : null}
        {isPreviousArtifact ? (
          <div
            style={{ fontSize: 12, padding: "6px 10px", opacity: 0.7 }}
            className="stream-mdx-mermaid-stale"
            role="status"
          >
            Showing the last valid diagram from an earlier source.
          </div>
        ) : null}
        {artifact ? (
          <div
            ref={containerRef}
            className="stream-mdx-mermaid-diagram"
            style={{ overflowX: "auto", padding: 10 }}
            /* biome-ignore lint/security/noDangerouslySetInnerHtml: SVG is produced by mermaid */
            dangerouslySetInnerHTML={{ __html: artifact.svg }}
          />
        ) : !currentError || !ErrorComponent ? (
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
/** Adapts the existing Mermaid block owner to the native code-owner engine contract. */
export function createMermaidEngine(options: CreateMermaidBlockOptions = {}): MermaidEngine {
  const Block = createMermaidBlock(options);
  const view: MermaidEngine["view"] = ({ source, children, metadata, actions }) =>
    React.createElement(Block, {
      code: source,
      renderCode: children,
      language: metadata.language ?? "mermaid",
      blockId: metadata.id,
      isFinalized: metadata.isFinalized,
      controls: { copy: true },
      copy: actions.copy,
    });
  return Object.freeze({ id: "stream-mdx-mermaid", view });
}

export const MermaidBlock: MermaidBlockComponent = createMermaidBlock();
