// Syntax highlighting with Shiki GrammarState for incremental rendering
// Supports both JS and WASM engines

import { normalizeLang } from "@stream-mdx/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";
import { type Highlighter, createHighlighter } from "shiki";
import type { CodeToHtmlOptions } from "shiki";

type GrammarState = Record<string, unknown> | undefined;

export interface HighlightState {
  grammarState?: GrammarState;
  html?: string;
  tokenCount?: number;
}

export interface HighlightConfig {
  engine: "js" | "wasm";
  themes: string[];
  langs: string[];
}

/**
 * Incremental syntax highlighter using Shiki
 */
export class IncrementalHighlighter {
  private highlighter: Highlighter | null = null;
  private config: HighlightConfig;
  private initialized = false;
  private preloadedLangs: Set<string> = new Set();
  private loadingLangs: Set<string> = new Set();

  constructor(config: HighlightConfig) {
    this.config = config;
  }

  /**
   * Initialize the highlighter with preloaded languages
   */
  async initialize(prewarmLangs: string[] = []): Promise<void> {
    if (this.initialized) return;

    const engine = this.config.engine === "wasm" ? await createOnigurumaEngine() : createJavaScriptRegexEngine();

    // Core languages that should always be available
    const coreLangs = ["javascript", "typescript", "json", "text", "markdown"];
    const initialLangs = [...coreLangs, ...prewarmLangs];

    this.highlighter = await createHighlighter({
      engine,
      langs: initialLangs,
      themes: this.config.themes,
    });

    // Track preloaded languages
    for (const lang of initialLangs) {
      this.preloadedLangs.add(normalizeLang(lang));
    }

    this.initialized = true;
  }

  /**
   * Highlight code with incremental state support (append-only)
   */
  async highlightAppend(prevState: HighlightState, nextChunk: string, lang: string, theme = "github-dark"): Promise<HighlightState> {
    if (!this.highlighter) {
      throw new Error("Highlighter not initialized");
    }

    const normalizedLang = normalizeLang(lang);

    try {
      // Use GrammarState for incremental highlighting
      const options: CodeToHtmlOptions & { grammarState?: GrammarState } = {
        lang: normalizedLang,
        theme,
      };

      if (prevState.grammarState) {
        options.grammarState = prevState.grammarState;
      }

      const highlighted = this.highlighter.codeToHtml(nextChunk, options);

      // Get the updated grammar state for next iteration
      const newGrammarState = this.getGrammarState(nextChunk, normalizedLang, theme);

      return {
        html: (prevState.html || "") + highlighted,
        grammarState: newGrammarState,
        tokenCount: (prevState.tokenCount || 0) + this.countTokens(highlighted),
      };
    } catch (error) {
      console.warn(`Highlighting failed for ${normalizedLang}:`, error);
      return {
        html: (prevState.html || "") + this.escapeHtml(nextChunk),
        grammarState: prevState.grammarState,
        tokenCount: prevState.tokenCount || 0,
      };
    }
  }

  /**
   * Highlight entire code block (for finalized blocks)
   */
  async highlight(code: string, lang: string, theme = "github-dark"): Promise<string> {
    if (!this.highlighter) {
      throw new Error("Highlighter not initialized");
    }

    const normalizedLang = normalizeLang(lang);

    try {
      return this.highlighter.codeToHtml(code, {
        lang: normalizedLang,
        theme,
      });
    } catch (error) {
      console.warn(`Highlighting failed for ${normalizedLang}:`, error);
      return `<pre><code class="language-${normalizedLang}">${this.escapeHtml(code)}</code></pre>`;
    }
  }

  /**
   * Generate CSS variables for theme switching
   */
  async generateThemeCSS(themes: string[]): Promise<string> {
    if (!this.highlighter) {
      throw new Error("Highlighter not initialized");
    }

    const cssRules: string[] = [];

    for (const theme of themes) {
      const themeData = this.highlighter.getTheme(theme);
      if (themeData) {
        const selector = theme === "github-light" ? ":root" : `[data-theme="${theme}"]`;

        cssRules.push(`${selector} {`);

        // Extract token colors and convert to CSS variables
        if (themeData.colors) {
          for (const [token, color] of Object.entries(themeData.colors)) {
            cssRules.push(`  --shiki-token-${token}: ${color};`);
          }
        }

        cssRules.push("}");
      }
    }

    return cssRules.join("\n");
  }

  /**
   * Check if language is supported
   */
  isLanguageSupported(lang: string): boolean {
    if (!this.highlighter) return false;
    const normalizedLang = normalizeLang(lang);
    return this.highlighter.getLoadedLanguages().includes(normalizedLang);
  }

  /**
   * Load additional language dynamically with deduplication
   */
  async loadLanguage(lang: string): Promise<void> {
    if (!this.highlighter) {
      throw new Error("Highlighter not initialized");
    }

    const normalizedLang = normalizeLang(lang);

    // Skip if already loaded or loading
    if (this.preloadedLangs.has(normalizedLang) || this.loadingLangs.has(normalizedLang)) {
      return;
    }

    // Check if already available in highlighter
    if (this.highlighter.getLoadedLanguages().includes(normalizedLang)) {
      this.preloadedLangs.add(normalizedLang);
      return;
    }

    // Mark as loading to prevent duplicate requests
    this.loadingLangs.add(normalizedLang);

    try {
      await this.highlighter.loadLanguage(normalizedLang);
      this.preloadedLangs.add(normalizedLang);
    } catch (error) {
      console.warn(`Failed to load language ${normalizedLang}:`, error);
    } finally {
      this.loadingLangs.delete(normalizedLang);
    }
  }

  /**
   * Check if language is loaded (not just supported)
   */
  isLanguageLoaded(lang: string): boolean {
    const normalizedLang = normalizeLang(lang);
    return this.preloadedLangs.has(normalizedLang);
  }

  /**
   * Get list of preloaded languages
   */
  getPreloadedLanguages(): string[] {
    return Array.from(this.preloadedLangs);
  }

  /**
   * Get grammar state for incremental highlighting
   * Note: This is a placeholder - actual implementation depends on Shiki's GrammarState API
   */
  private getGrammarState(code: string, lang: string, theme: string): GrammarState {
    // This would use Shiki's actual GrammarState API
    // For now, return a mock state
    return {
      lang,
      theme,
      lastLineState: null, // Would contain actual TextMate rule stack
    };
  }

  /**
   * Count tokens in highlighted HTML (for performance metrics)
   */
  private countTokens(html: string): number {
    const tokenRegex = /<span[^>]*>/g;
    const matches = html.match(tokenRegex);
    return matches ? matches.length : 0;
  }

  /**
   * Escape HTML for fallback rendering
   */
  private escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}

/**
 * Line-by-line highlighting for in-place edits
 * Uses vscode-textmate for per-line convergence
 */
export class LineBasedHighlighter {
  private registry: unknown; // vscode-textmate Registry
  private grammar: {
    tokenizeLine?(line: string, ruleStack: RuleStack | null): TokenizeResult;
  } | null = null;
  private lineCache: Array<{ tokens: unknown; endState: RuleStack | null }> = [];

  constructor(registry?: unknown, grammar?: { tokenizeLine?(line: string, ruleStack: RuleStack | null): TokenizeResult }) {
    this.registry = registry ?? null;
    this.grammar = grammar ?? null;
  }

  /**
   * Re-tokenize from changed line until convergence
   */
  async retokenizeFromLine(lines: string[], fromLine: number): Promise<void> {
    if (!this.grammar || typeof this.grammar.tokenizeLine !== "function") return;

    let ruleStack: RuleStack | null = fromLine > 0 ? (this.lineCache[fromLine - 1]?.endState ?? null) : null;

    for (let i = fromLine; i < lines.length; i++) {
      const result = this.grammar.tokenizeLine(lines[i], ruleStack);

      // Check for convergence
      if (this.lineCache[i] && this.shallowEqual(this.lineCache[i].endState, result.ruleStack)) {
        break; // Convergence point reached
      }

      // Update cache
      this.lineCache[i] = {
        tokens: result.tokens,
        endState: result.ruleStack,
      };

      ruleStack = result.ruleStack;
    }
  }

  /**
   * Shallow equality check for rule stacks
   */
  private shallowEqual(a: RuleStack | null, b: RuleStack | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;

    // Simplified equality check
    return JSON.stringify(a) === JSON.stringify(b);
  }
}

type RuleStack = Record<string, unknown>;
type TokenizeResult = {
  tokens: unknown;
  ruleStack: RuleStack | null;
};

/**
 * Factory function to create highlighter instances
 */
export async function createIncrementalHighlighter(config: HighlightConfig): Promise<IncrementalHighlighter> {
  const highlighter = new IncrementalHighlighter(config);
  await highlighter.initialize();
  return highlighter;
}
