// React components for rendering math expressions

import { DisplayMathWrapper } from "@stream-mdx/react/math/display-wrapper";
import React from "react";

/**
 * Props for math rendering components
 */
interface MathProps {
  /** LaTeX/TeX expression to render */
  tex: string;

  /** Whether this is display math (block) or inline */
  display?: boolean;

  /** Raw math content including delimiters */
  raw?: string;

  /** Additional CSS classes */
  className?: string;

  /** Validation errors if any */
  errors?: string[];

  /** Whether the math expression is valid */
  valid?: boolean;
}

/**
 * Inline math renderer component ($...$)
 */
export const MathInlineRenderer: React.FC<MathProps> = ({ tex, raw, className = "", errors = [], valid = true }) => {
  // If there are errors, show error state
  if (!valid && errors.length > 0) {
    return (
      <span
        className={`math-inline-error ${className}`}
        title={`Math Error: ${errors.join(", ")}`}
        style={{
          color: "#d73a49",
          backgroundColor: "#ffeef0",
          padding: "2px 4px",
          borderRadius: "3px",
          fontFamily: "monospace",
          fontSize: "0.9em",
        }}
      >
        {raw || `$${tex}$`}
      </span>
    );
  }

  // For now, render as styled span (would integrate with KaTeX/MathJax in real implementation)
  return (
    <span
      className={`math-inline ${className}`}
      data-tex={tex}
      style={{
        fontFamily: 'KaTeX_Math, "Times New Roman", serif',
        fontStyle: "italic",
        backgroundColor: "#f6f8fa",
        padding: "2px 4px",
        borderRadius: "3px",
        border: "1px solid #e1e4e8",
      }}
    >
      {/* In a real implementation, this would be KaTeX rendered content */}
      <span style={{ fontFamily: "monospace", fontSize: "0.9em", color: "#666" }}>${tex}$</span>
    </span>
  );
};

/**
 * Display math renderer component ($$...$$)
 */
export const MathDisplayRenderer: React.FC<MathProps> = ({ tex, raw, className = "", errors = [], valid = true }) => {
  // If there are errors, show error state
  if (!valid && errors.length > 0) {
    return (
      <DisplayMathWrapper className={`math-display-error ${className}`}>
        <div style={{ fontWeight: "bold", marginBottom: "8px" }}>Math Expression Error:</div>
        <ul style={{ margin: 0, paddingLeft: "20px" }}>
          {errors.map((error) => (
            <li key={`${error}-${tex}`}>{error}</li>
          ))}
        </ul>
        <pre
          style={{
            marginTop: "8px",
            padding: "8px",
            backgroundColor: "#f6f8fa",
            borderRadius: "3px",
            fontSize: "0.9em",
            fontFamily: "monospace",
            overflow: "auto",
          }}
        >
          {raw || `$$${tex}$$`}
        </pre>
      </DisplayMathWrapper>
    );
  }

  // For now, render as styled div (would integrate with KaTeX/MathJax in real implementation)
  return (
    <DisplayMathWrapper className={`math-display ${className}`}>
      {/* In a real implementation, this would be KaTeX rendered content */}
      <div
        style={{
          fontFamily: "monospace",
          fontSize: "0.95em",
          color: "#666",
          whiteSpace: "pre-wrap",
        }}
      >
        $${tex}$$
      </div>
    </DisplayMathWrapper>
  );
};

/**
 * Generic math renderer that chooses inline or display based on props
 */
export const MathRenderer: React.FC<MathProps> = (props) => {
  if (props.display) {
    return <MathDisplayRenderer {...props} />;
  }
  return <MathInlineRenderer {...props} />;
};

/**
 * Math renderer with KaTeX integration (for future implementation)
 */
export const KaTeXMathRenderer: React.FC<MathProps> = ({ tex, display = false, className = "", errors = [], valid = true }) => {
  // This would be the actual KaTeX integration
  // For now, fall back to the basic renderers

  if (display) {
    return <MathDisplayRenderer tex={tex} display={display} className={className} errors={errors} valid={valid} />;
  }
  return <MathInlineRenderer tex={tex} display={display} className={className} errors={errors} valid={valid} />;
};

/**
 * Math error boundary component
 */
interface MathErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

interface MathErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ComponentType<{ error: Error }>;
}

export class MathErrorBoundary extends React.Component<MathErrorBoundaryProps, MathErrorBoundaryState> {
  constructor(props: MathErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): MathErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Math rendering error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      const FallbackComponent = this.props.fallback;

      if (FallbackComponent && this.state.error) {
        return <FallbackComponent error={this.state.error} />;
      }

      return (
        <div
          style={{
            padding: "8px",
            backgroundColor: "#ffeef0",
            border: "1px solid #fdaeb7",
            borderRadius: "4px",
            color: "#d73a49",
            fontSize: "0.9em",
          }}
        >
          Math rendering failed
        </div>
      );
    }

    return this.props.children;
  }
}
