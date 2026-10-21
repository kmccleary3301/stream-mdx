import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import type { ComponentType } from "react";
import type {
  TrustedMdxCompiledRegion,
  TrustedMdxRenderProps,
} from "../trusted-mdx-contract";

export interface EvaluatedMdxModule {
  readonly createRegions: (
    props: TrustedMdxRenderProps,
  ) => Readonly<Record<string, TrustedMdxCompiledRegion>>;
  readonly layout?: ComponentType<TrustedMdxRenderProps> | null;
}

export interface EvaluateMdxOptions {
  readonly imports?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

// The AsyncFunction instance runs this compiler-owned private ABI and returns its module namespace.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<EvaluatedMdxModule>;

export async function evaluateCompiledMdx(
  code: string,
  options: EvaluateMdxOptions,
  canInvoke: () => boolean,
): Promise<EvaluatedMdxModule | null> {
  const hostImports = options.imports;

  const resolveSyncHostImport = (specifier: string): unknown => {
    if (specifier === "react") {
      return { default: React, ...React };
    }
    if (specifier === "react/jsx-runtime") {
      return jsxRuntime;
    }
    if (hostImports && Object.prototype.hasOwnProperty.call(hostImports, specifier)) {
      return hostImports[specifier];
    }
    throw new Error(
      `Cannot resolve MDX import specifier "${specifier}": no host binding configured. Automatic fetching and network egress are disabled.`,
    );
  };

  async function resolveDynamicHostImport(specifier: string): Promise<unknown> {
    return resolveSyncHostImport(specifier);
  }

  const runtime = {
    Fragment: jsxRuntime.Fragment,
    jsx: jsxRuntime.jsx,
    jsxs: jsxRuntime.jsxs,
    _resolveSyncHostImport: resolveSyncHostImport,
    _resolveDynamicHostImport: resolveDynamicHostImport,
  };

  const fn = new AsyncFunction(code);
  // No async boundary separates ownership validation from invoking authored module code.
  if (!canInvoke()) return null;
  return fn(runtime);
}
