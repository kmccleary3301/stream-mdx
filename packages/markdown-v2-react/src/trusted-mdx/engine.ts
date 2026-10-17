import type { TrustedMdxArtifact } from "@stream-mdx/core";
import {
  compileTrustedMdxDocument,
  TRUSTED_MDX_COMPILER_REVISION,
} from "@stream-mdx/worker/mdx-compile";
import type {
  TrustedMdxDocument,
  TrustedMdxEngine,
  TrustedMdxEngineOptions,
} from "../trusted-mdx-contract";
import { createTrustedMdxDocumentLease } from "./document";

/**
 * Creates the explicit TrustedMDX addon engine with one pure artifact cache and isolated leases.
 */
export function createTrustedMdxEngine(options: TrustedMdxEngineOptions = {}): TrustedMdxEngine {
  const frozenComponents = options.components
    ? Object.freeze({ ...options.components })
    : undefined;
  let frozenImports: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
  if (options.imports) {
    const importNamespaces: Array<readonly [string, Readonly<Record<string, unknown>>]> = [];
    for (const [specifier, namespace] of Object.entries(options.imports)) {
      importNamespaces.push([specifier, Object.freeze({ ...namespace })]);
    }
    frozenImports = Object.freeze(Object.fromEntries(importNamespaces));
  }

  const immutableOptions: TrustedMdxEngineOptions = Object.freeze({
    components: frozenComponents,
    imports: frozenImports,
    compile: options.compile,
    compilerIdentity: options.compilerIdentity ?? TRUSTED_MDX_COMPILER_REVISION,
  });
  const compileFn = immutableOptions.compile;

  let factoryEpoch = 0;
  let isDisposed = false;
  let lastArtifactSource: string | null = null;
  let lastArtifact: TrustedMdxArtifact | null = null;
  const inflightCompilations = new Map<string, Promise<TrustedMdxArtifact>>();
  const activeLeases = new Set<TrustedMdxDocument>();
  const generationListeners = new Set<() => void>();

  const getOrCompileArtifact = (source: string): Promise<TrustedMdxArtifact> => {
    if (isDisposed) {
      return Promise.reject(new Error("Cannot compile MDX revision: TrustedMdxEngine has been disposed."));
    }
    if (lastArtifactSource === source && lastArtifact !== null) {
      return Promise.resolve(lastArtifact);
    }

    const existingCompilation = inflightCompilations.get(source);
    if (existingCompilation) return existingCompilation;

    const startFactoryEpoch = factoryEpoch;
    let compilation: Promise<TrustedMdxArtifact>;
    compilation = Promise.resolve()
      .then(() => {
        if (isDisposed || factoryEpoch !== startFactoryEpoch) {
          throw new Error("TrustedMDX compilation was invalidated before it started.");
        }
        return compileFn
          ? compileFn(source)
          : compileTrustedMdxDocument(source);
      })
      .then((artifact) => {
        if (!isDisposed && factoryEpoch === startFactoryEpoch) {
          lastArtifactSource = source;
          lastArtifact = artifact;
        }
        return artifact;
      })
      .finally(() => {
        if (inflightCompilations.get(source) === compilation) {
          inflightCompilations.delete(source);
        }
      });

    inflightCompilations.set(source, compilation);
    return compilation;
  };

  const getFactoryEpoch = (): number => factoryEpoch;
  const getGeneration = (): number => factoryEpoch;

  const subscribe = (listener: () => void): (() => void) => {
    if (!isDisposed) generationListeners.add(listener);
    return () => {
      generationListeners.delete(listener);
    };
  };

  const notifyGenerationListeners = (): void => {
    let notificationFailed = false;
    let notificationFailure: unknown;
    for (const listener of generationListeners) {
      try {
        listener();
      } catch (cause) {
        if (!notificationFailed) {
          notificationFailed = true;
          notificationFailure = cause;
        }
      }
    }
    if (notificationFailed) throw notificationFailure;
  };

  const createDocument = (): TrustedMdxDocument => {
    if (isDisposed) {
      throw new Error("Cannot create document: TrustedMdxEngine has been disposed.");
    }

    let document: TrustedMdxDocument | null = null;
    const createdDocument = createTrustedMdxDocumentLease({
      options: immutableOptions,
      getFactoryEpoch,
      getOrCompileArtifact,
      onDispose: () => {
        if (document !== null) activeLeases.delete(document);
      },
    });
    document = createdDocument;
    activeLeases.add(createdDocument);
    return createdDocument;
  };

  const clearCache = (): void => {
    if (isDisposed) return;
    factoryEpoch += 1;
    lastArtifactSource = null;
    lastArtifact = null;
    inflightCompilations.clear();
    let notificationFailed = false;
    let notificationFailure: unknown;
    try {
      notifyGenerationListeners();
    } catch (cause) {
      notificationFailed = true;
      notificationFailure = cause;
    }

    for (const document of activeLeases) {
      try {
        document.clear();
      } catch (cause) {
        if (!notificationFailed) {
          notificationFailed = true;
          notificationFailure = cause;
        }
      }
    }
    if (notificationFailed) throw notificationFailure;
  };

  const dispose = (): void => {
    if (isDisposed) return;
    isDisposed = true;
    factoryEpoch += 1;
    lastArtifactSource = null;
    lastArtifact = null;
    inflightCompilations.clear();

    let notificationFailed = false;
    let notificationFailure: unknown;
    try {
      notifyGenerationListeners();
    } catch (cause) {
      notificationFailed = true;
      notificationFailure = cause;
    }
    for (const document of activeLeases) {
      try {
        document.dispose();
      } catch (cause) {
        if (!notificationFailed) {
          notificationFailed = true;
          notificationFailure = cause;
        }
      }
    }
    activeLeases.clear();
    generationListeners.clear();
    if (notificationFailed) throw notificationFailure;
  };

  return {
    createDocument,
    getGeneration,
    subscribe,
    clearCache,
    dispose,
  };
}
