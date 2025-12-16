// MDX client-side integration
// Handles compilation requests and component hydration

import type { Block } from "@stream-mdx/core";
import React from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";

type ElementProps = Record<string, unknown> & { children?: React.ReactNode | React.ReactNode[] };
type JsxFactory = (type: React.ElementType, props?: ElementProps, key?: React.Key) => React.ReactElement;
const withClassName = <Tag extends keyof JSX.IntrinsicElements>(tag: Tag, className: string) => {
  return (props: React.ComponentPropsWithoutRef<Tag>) => React.createElement(tag, { className, ...props });
};

type JsxDevFactory = typeof import("react/jsx-dev-runtime").jsxDEV;
type ExtendedJsxRuntime = typeof ReactJsxRuntime & { jsxDEV?: JsxDevFactory };
type MdxComponentProps = Record<string, unknown> & { components?: Record<string, React.ComponentType> };
type MdxRuntimeComponent = React.ComponentType<MdxComponentProps>;

function assignMdxChildKey(child: React.ReactNode, index: number | string): React.ReactNode {
  if (child == null) return child;
  if (Array.isArray(child)) {
    return child.map((entry, subIndex) => assignMdxChildKey(entry, `${index}-${subIndex}`));
  }
  if (React.isValidElement(child)) {
    if (child.key !== null && child.key !== undefined) {
      return child;
    }
    return React.cloneElement(child, { key: index });
  }
  return child;
}

/**
 * MDX compilation client
 */
export class MDXClient {
  private compileEndpoint: string;
  private cache = new Map<string, Promise<CompiledMDX>>();
  private inlineModules = new Map<string, CompiledMDX>();

  constructor(compileEndpoint = "/api/mdx-compile-v2") {
    this.compileEndpoint = compileEndpoint;
  }

  /**
   * Compile MDX block on server
   */
  async compile(block: Block): Promise<CompiledMDX> {
    if (block.type !== "mdx") {
      throw new Error("Block is not MDX type");
    }

    const cacheKey = block.id;

    // Check if compilation is already in progress
    const cachedPromise = this.cache.get(cacheKey);
    if (cachedPromise) {
      return cachedPromise;
    }

    // Start compilation
    const compilationPromise = this.doCompile(block);
    this.cache.set(cacheKey, compilationPromise);

    try {
      const result = await compilationPromise;
      return result;
    } catch (error) {
      // Remove from cache on error
      this.cache.delete(cacheKey);
      throw error;
    }
  }

  /**
   * Get compiled MDX by reference
   */
  async getCompiled(ref: { id: string }): Promise<CompiledMDX> {
    const inline = this.inlineModules.get(ref.id);
    if (inline) {
      return {
        ...inline,
        dependencies: Array.isArray(inline.dependencies) ? [...inline.dependencies] : [],
      };
    }

    const response = await fetch(`${this.compileEndpoint}?id=${ref.id}`);

    if (!response.ok) {
      throw new Error(`Failed to get compiled MDX: ${response.statusText}`);
    }

    const data = await response.json();
    return {
      id: data.id,
      code: data.code,
      dependencies: data.dependencies || [],
      timestamp: data.timestamp,
    };
  }

  /**
   * Clear compilation cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  registerInlineModule(compiled: CompiledMDX): void {
    this.inlineModules.set(compiled.id, {
      ...compiled,
      dependencies: Array.isArray(compiled.dependencies) ? [...compiled.dependencies] : [],
    });
  }

  clearInlineModules(): void {
    this.inlineModules.clear();
  }

  /**
   * Actual compilation implementation
   */
  private async doCompile(block: Block): Promise<CompiledMDX> {
    const response = await fetch(this.compileEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: block.payload.raw,
        blockId: block.id,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(`MDX compilation failed: ${error.error || response.statusText}`);
    }

    const data = await response.json();
    return {
      id: data.id,
      code: data.code,
      dependencies: data.dependencies || [],
      cached: data.cached || false,
    };
  }
}

/**
 * Compiled MDX result
 */
export interface CompiledMDX {
  id: string;
  code: string;
  dependencies: string[];
  cached?: boolean;
  timestamp?: number;
}

/**
 * MDX component factory
 */
export class MDXComponentFactory {
  private components = new Map<string, React.ComponentType>();
  private mdxClient: MDXClient;
  private baseComponents: Record<string, React.ComponentType>;
  private customComponents = new Map<string, React.ComponentType>();

  constructor(mdxClient: MDXClient) {
    this.mdxClient = mdxClient;
    this.baseComponents = this.createBaseComponents();
  }

  registerInlineModule(module: CompiledMDX): void {
    this.mdxClient.registerInlineModule(module);
    this.components.delete(module.id);
  }

  /**
   * Create React component from compiled MDX
   */
  async createComponent(ref: { id: string }): Promise<React.ComponentType> {
    // Check cache first
    const cached = this.components.get(ref.id);
    if (cached) {
      return cached;
    }

    // Get compiled MDX
    const compiled = await this.mdxClient.getCompiled(ref);

    // Create component function
    const component = this.evaluateCompiledMDX(compiled);

    // Cache component
    this.components.set(ref.id, component);

    return component;
  }

  /**
   * Safely evaluate compiled MDX code
   */
  private evaluateCompiledMDX(compiled: CompiledMDX): MdxRuntimeComponent {
    try {
      const context = this.createEvaluationContext();
      const argNames = Object.keys(context);
      const argValues = Object.values(context);

      const moduleExports = new Function(...argNames, compiled.code)(...argValues);
      const MDXComponent = this.resolveEvaluatedModule(moduleExports);

      return (props: MdxComponentProps) => {
        const registryComponents = this.getComponents();
        const incomingComponents = props?.components as Record<string, React.ComponentType> | undefined;
        const mergedComponents = incomingComponents ? { ...registryComponents, ...incomingComponents } : registryComponents;

        return React.createElement(MDXComponent, {
          ...props,
          components: mergedComponents,
        });
      };
    } catch (error) {
      console.error("Failed to evaluate MDX:", error);

      return () =>
        React.createElement(
          "div",
          {
            className: "mdx-error",
          },
          `MDX Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
    }
  }

  /**
   * Create safe evaluation context for MDX
   */
  private createEvaluationContext(): Record<string, unknown> {
    const runtime: ExtendedJsxRuntime = ReactJsxRuntime as ExtendedJsxRuntime;

    const createElementWithChildren: JsxFactory = (type, props, key) => {
      const baseProps = props ?? {};
      const finalProps = key === undefined || key === null ? baseProps : { ...baseProps, key };
      if (Array.isArray(finalProps.children)) {
        finalProps.children = finalProps.children.map((child, index) => assignMdxChildKey(child, index));
      }
      return React.createElement(type, finalProps);
    };

    const runtimeJsx = typeof runtime.jsx === "function" ? runtime.jsx.bind(runtime) : createElementWithChildren;
    const runtimeJsxs = typeof runtime.jsxs === "function" ? runtime.jsxs.bind(runtime) : createElementWithChildren;
    const runtimeJsxDEV =
      typeof runtime.jsxDEV === "function"
        ? runtime.jsxDEV.bind(runtime)
        : (type: React.ElementType, props?: ElementProps, key?: React.Key, ..._rest: unknown[]) => createElementWithChildren(type, props, key);

    const jsxRuntime = {
      jsx: runtimeJsx,
      jsxs: runtimeJsxs,
      jsxDEV: runtimeJsxDEV,
      Fragment: runtime.Fragment ?? React.Fragment,
    };

    return {
      __mdx_runtime: jsxRuntime,
      React,
      Fragment: React.Fragment,
      useState: React.useState,
      useEffect: React.useEffect,
      useMemo: React.useMemo,
      useCallback: React.useCallback,
      useRef: React.useRef,
      useContext: React.useContext,
      useReducer: React.useReducer,
      useLayoutEffect: React.useLayoutEffect,
      console: {
        log: console.log,
        warn: console.warn,
        error: console.error,
      },
    };
  }

  private resolveEvaluatedModule(output: unknown): MdxRuntimeComponent {
    if (!output) {
      throw new Error("Compiled MDX module returned no exports");
    }

    if (typeof output === "function") {
      return output as MdxRuntimeComponent;
    }

    if (typeof (output as { default?: unknown }).default === "function") {
      return (output as { default: MdxRuntimeComponent }).default;
    }

    if (typeof (output as { MDXContent?: unknown }).MDXContent === "function") {
      return (output as { MDXContent: MdxRuntimeComponent }).MDXContent;
    }

    throw new Error("Compiled MDX module did not export a component");
  }

  private getComponents(): Record<string, React.ComponentType> {
    if (this.customComponents.size === 0) {
      return { ...this.baseComponents };
    }
    const merged: Record<string, React.ComponentType> = { ...this.baseComponents };
    for (const [key, component] of this.customComponents) {
      merged[key] = component;
    }
    return merged;
  }

  /**
   * Register or replace custom MDX components
   */
  registerComponents(components: Record<string, React.ComponentType | undefined>, options?: { replace?: boolean }): void {
    if (options?.replace) {
      this.customComponents.clear();
    }
    for (const [key, component] of Object.entries(components)) {
      if (!component) continue;
      this.customComponents.set(key, component);
    }
  }

  /**
   * Get base MDX components
   */
  private createBaseComponents(): Record<string, React.ComponentType> {
    return {
      // Standard HTML elements
      h1: withClassName("h1", "mdx-h1"),
      h2: withClassName("h2", "mdx-h2"),
      h3: withClassName("h3", "mdx-h3"),
      h4: withClassName("h4", "mdx-h4"),
      h5: withClassName("h5", "mdx-h5"),
      h6: withClassName("h6", "mdx-h6"),

      p: withClassName("p", "mdx-p"),
      strong: withClassName("strong", "mdx-strong"),
      em: withClassName("em", "mdx-em"),

      code: withClassName("code", "mdx-code"),
      pre: withClassName("pre", "mdx-pre"),

      ul: withClassName("ul", "mdx-ul"),
      ol: withClassName("ol", "mdx-ol"),
      li: withClassName("li", "mdx-li"),

      blockquote: withClassName("blockquote", "mdx-blockquote"),

      a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) =>
        React.createElement("a", {
          className: "mdx-link",
          target: props.href?.startsWith("http") ? "_blank" : undefined,
          rel: props.href?.startsWith("http") ? "noopener noreferrer" : undefined,
          ...props,
        }),

      img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => React.createElement("img", { className: "mdx-img", ...props }),

      table: withClassName("table", "mdx-table"),
      thead: withClassName("thead", "mdx-thead"),
      tbody: withClassName("tbody", "mdx-tbody"),
      tr: withClassName("tr", "mdx-tr"),
      th: withClassName("th", "mdx-th"),
      td: withClassName("td", "mdx-td"),
    };
  }

  /**
   * Clear component cache
   */
  clearCache(): void {
    this.components.clear();
  }

  clearCustomComponents(): void {
    this.customComponents.clear();
  }
}

/**
 * Global MDX client instance
 */
let globalMDXClient: MDXClient | null = null;
let globalComponentFactory: MDXComponentFactory | null = null;

/**
 * Get or create global MDX client
 */
export function getMDXClient(compileEndpoint?: string): MDXClient {
  if (!globalMDXClient) {
    globalMDXClient = new MDXClient(compileEndpoint);
  }
  return globalMDXClient;
}

/**
 * Get or create global component factory
 */
export function getMDXComponentFactory(compileEndpoint?: string): MDXComponentFactory {
  if (!globalComponentFactory) {
    const client = getMDXClient(compileEndpoint);
    globalComponentFactory = new MDXComponentFactory(client);
  }
  return globalComponentFactory;
}

export function registerMDXComponents(components: Record<string, React.ComponentType | undefined>, options?: { replace?: boolean }) {
  const factory = getMDXComponentFactory();
  factory.registerComponents(components, options);
}

export function registerInlineMdxModule(compiled: {
  id: string;
  code: string;
  dependencies?: string[];
}): void {
  const factory = getMDXComponentFactory();
  factory.registerInlineModule({
    id: compiled.id,
    code: compiled.code,
    dependencies: compiled.dependencies ?? [],
  });
}
