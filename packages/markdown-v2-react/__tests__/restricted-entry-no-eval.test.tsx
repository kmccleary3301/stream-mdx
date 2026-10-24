import assert from "node:assert/strict";
import { Worker as NodeWorker } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import type { HtmlTreeNode } from "@stream-mdx/core";
import { createInlineEngineWorker } from "../../markdown-v2-worker/src/engine";
import { defineContentComponent, type ContentComponentHostProps, type ContentComponentProps } from "../src/components/content-components";
import { StreamingMarkdown, type StreamingMarkdownHandle } from "../src/streaming-markdown";

interface EvaluationTraps {
  readonly attempts: string[];
  restore(): void;
}

interface EvaluationRealm {
  readonly name: string;
  readonly realm: typeof globalThis;
}

interface ConstructorPrototype {
  readonly name: string;
  readonly prototype: object;
}

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  MessageEvent: dom.window.MessageEvent,
  ErrorEvent: dom.window.ErrorEvent,
  Worker: NodeWorker,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previousGlobals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const effects: string[] = [];
const effectProperty = "__streamMdxRestrictedNoEvalEffects";
const priorEffectDescriptors = [globalThis, dom.window].map((target) => ({
  target,
  descriptor: Object.getOwnPropertyDescriptor(target, effectProperty),
}));
Object.defineProperty(globalThis, effectProperty, { configurable: true, value: effects });
Object.defineProperty(dom.window, effectProperty, { configurable: true, value: effects });

function constructorPrototypesFor(realm: typeof globalThis, name: string): ConstructorPrototype[] {
  const asyncFunction = realm.Function("return async function () {}")();
  const generatorFunction = realm.Function("return function* () {}")();
  const asyncGeneratorFunction = realm.Function("return async function* () {}")();
  return [
    { name: `${name}.Function.prototype.constructor`, prototype: realm.Function.prototype },
    { name: `${name}.AsyncFunction.prototype.constructor`, prototype: Object.getPrototypeOf(asyncFunction) },
    { name: `${name}.GeneratorFunction.prototype.constructor`, prototype: Object.getPrototypeOf(generatorFunction) },
    { name: `${name}.AsyncGeneratorFunction.prototype.constructor`, prototype: Object.getPrototypeOf(asyncGeneratorFunction) },
  ];
}

function installEvaluationTraps(realms: readonly EvaluationRealm[]): EvaluationTraps {
  const attempts: string[] = [];
  const previous: Array<{ target: object; key: PropertyKey; descriptor: PropertyDescriptor | undefined }> = [];
  const seen = new Map<object, Set<PropertyKey>>();
  const denied = (name: string): never => {
    const error = new Error(`restricted content reached ${name}`);
    attempts.push(error.stack ?? error.message);
    throw error;
  };
  const blocker = (name: string) => new Proxy(function blockedEvaluation(): never {
    return denied(name);
  }, {
    apply: () => denied(name),
    construct: () => denied(name),
  });

  const wasSeen = (target: object, key: PropertyKey): boolean => {
    const keys = seen.get(target);
    if (keys?.has(key)) return true;
    const nextKeys = keys ?? new Set<PropertyKey>();
    nextKeys.add(key);
    seen.set(target, nextKeys);
    return false;
  };
  const replaceValue = (target: object, key: PropertyKey, label: string): void => {
    if (wasSeen(target, key)) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    assert.ok(descriptor?.configurable, `${label} must be configurable for the runtime trap`);
    previous.push({ target, key, descriptor });
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: descriptor.enumerable,
      writable: true,
      value: blocker(label),
    });
  };
  const replaceConstructorAccess = (prototype: object, label: string): void => {
    if (wasSeen(prototype, "constructor")) return;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");
    assert.ok(descriptor?.configurable, `${label} must be configurable for the runtime trap`);
    previous.push({ target: prototype, key: "constructor", descriptor });
    Object.defineProperty(prototype, "constructor", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: () => denied(label),
    });
  };
  const restore = (): void => {
    for (const { target, key, descriptor } of previous.reverse()) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
  };

  // Build the realm-local intrinsic list before replacing globals so ordinary initialization
  // cannot be mistaken for content evaluation.
  const constructors = realms.flatMap(({ name, realm }) => constructorPrototypesFor(realm, name));
  try {
    for (const { name, realm } of realms) {
      replaceValue(realm, "Function", `${name}.Function`);
      replaceValue(realm, "eval", `${name}.eval`);
    }
    for (const { name, prototype } of constructors) replaceConstructorAccess(prototype, name);
  } catch (error) {
    restore();
    throw error;
  }

  return { attempts, restore };
}

function findTreeNodes(nodes: readonly HtmlTreeNode[], output: HtmlTreeNode[] = []): HtmlTreeNode[] {
  for (const node of nodes) {
    output.push(node);
    if (node.kind === "element" || node.kind === "component") {
      findTreeNodes(node.children, output);
    } else if (node.kind === "block") {
      const nested = node.block.payload.meta?.htmlTree;
      if (Array.isArray(nested)) findTreeNodes(nested as HtmlTreeNode[], output);
    }
  }
  return output;
}

function describeFailureState(
  handle: React.RefObject<StreamingMarkdownHandle>,
  container: HTMLElement,
  reportedErrors: readonly Error[],
  effectTrace: readonly string[],
  traps: EvaluationTraps | undefined,
): string {
  const state = handle.current?.getState();
  const blocks = state?.blocks.slice(0, 12).map((block) => {
    const tree = block.payload.meta?.htmlTree;
    const nodes = Array.isArray(tree) ? findTreeNodes(tree as HtmlTreeNode[]).slice(0, 12) : [];
    return {
      id: block.id,
      type: block.type,
      finalized: block.isFinalized,
      raw: typeof block.payload.raw === "string" ? block.payload.raw.slice(0, 160) : undefined,
      tree: nodes.map((node) => {
        if (node.kind === "component") return { kind: node.kind, name: node.name, status: node.status, diagnostic: node.diagnostic };
        if (node.kind === "text") return { kind: node.kind, text: node.text.slice(0, 100), diagnostic: node.diagnostic };
        if (node.kind === "element") return { kind: node.kind, tagName: node.tagName };
        return { kind: node.kind, blockType: node.block.type };
      }),
    };
  });
  const renderedOutputs = Array.from(container.getElementsByTagName("output")).slice(0, 12).map((node) => ({
    text: node.textContent?.slice(0, 100),
    title: node.getAttribute("data-restricted-card"),
    status: node.getAttribute("data-component-status"),
    diagnostic: node.getAttribute("data-diagnostic"),
  }));
  return JSON.stringify({
    workerReady: state?.workerReady,
    queueDepth: state?.queueDepth,
    pendingBatches: state?.pendingBatches,
    blocks,
    domText: container.textContent?.slice(0, 1200),
    renderedOutputs,
    reportedErrors: reportedErrors.slice(0, 5).map((error) => ({
      name: error.name,
      message: error.message,
      stack: error.stack?.slice(0, 400),
    })),
    effects: effectTrace.slice(0, 12),
    trapAttempts: traps?.attempts.slice(0, 12),
  }, null, 2);
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  failureState: () => string,
): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${message}\nFailure state:\n${failureState()}`);
    await act(async () => { await delay(10); });
  }
}



async function testDefaultRestrictedEntryNeverEvaluatesContent(): Promise<void> {
  type CardSourceProps = { title?: string; count?: number; enabled?: boolean };
  type CardProps = CardSourceProps & ContentComponentHostProps;
  type FileViewerSourceProps = {
    path: string;
    meta: { tier: string; nested: { flag: boolean } };
  };
  const fileViewerCases = [
    {
      source: '<FileViewer path="C:\\tools\\app" meta={{"tier":"prod","nested":{"flag":true}}} />',
      path: "C:\\tools\\app",
    },
    {
      source: '<FileViewer path="C:\\" meta={{"tier":"prod","nested":{"flag":true}}} />',
      path: "C:\\",
    },
    {
      source: '<FileViewer path={"quoted \\" > value"} meta={{"tier":"prod","nested":{"flag":true}}} />',
      path: 'quoted " > value',
    },
  ];
  const fileViewerObservations: Array<{
    path: string;
    propsFrozen: boolean;
    metaFrozen: boolean;
    nestedFrozen: boolean;
  }> = [];
  const RegisteredFileViewer: React.FC<FileViewerSourceProps & ContentComponentHostProps> = (props) => {
    fileViewerObservations.push({
      path: props.path,
      propsFrozen: Object.isFrozen(props),
      metaFrozen: Object.isFrozen(props.meta),
      nestedFrozen: Object.isFrozen(props.meta.nested),
    });
    return <output data-file-viewer-path={props.path}>{props.meta.tier}</output>;
  };
  const fileViewerRegistration = defineContentComponent<FileViewerSourceProps>({
    component: RegisteredFileViewer,
    validateProps: (props: ContentComponentProps): props is ContentComponentProps & FileViewerSourceProps =>
      typeof props.path === "string" &&
      props.meta !== null &&
      typeof props.meta === "object" &&
      "tier" in props.meta &&
      typeof props.meta.tier === "string" &&
      "nested" in props.meta &&
      props.meta.nested !== null &&
      typeof props.meta.nested === "object" &&
      "flag" in props.meta.nested &&
      typeof props.meta.nested.flag === "boolean",
  });
  const RegisteredCard: React.FC<CardProps> = ({ title, count, enabled, ...hostProps }) => (
    <output
      data-restricted-card={title ?? ""}
      data-count={count === undefined ? "" : String(count)}
      data-enabled={enabled === undefined ? "" : String(enabled)}
      data-component-status={hostProps["data-component-status"]}
      data-diagnostic={hostProps["data-diagnostic"]}
    >
      {title}
    </output>
  );
  const cardRegistration = defineContentComponent<CardSourceProps>({
    component: RegisteredCard,
    validateProps: (props: ContentComponentProps): props is ContentComponentProps & CardSourceProps =>
      typeof props.title === "string" &&
      (props.count === undefined || (typeof props.count === "number" && Number.isSafeInteger(props.count))) &&
      (props.enabled === undefined || typeof props.enabled === "boolean"),
  });
  const contentComponents = { Card: cardRegistration, FileViewer: fileViewerRegistration };
  const source = [
    '<Card title="literal-safe" count={7} enabled />',
    "",
    ...fileViewerCases.flatMap(({ source: componentSource }) => [componentSource, ""]),
    '<UnknownWidget title="unknown-authored-source" />',
    "",
    "<Card 12345>",
    "",
    '{globalThis.__streamMdxRestrictedNoEvalEffects.push("brace-expression")}',
    `{Function("return globalThis.${effectProperty}.push('function-constructor')")()}`,
    `{eval("globalThis.${effectProperty}.push('eval-call')")}`,
    `{Object.getPrototypeOf(async function () {}).constructor("return globalThis.${effectProperty}.push('async-constructor')")()}`,
    "",
    '<Card title={globalThis.__streamMdxRestrictedNoEvalEffects.push("attribute-expression")} />',
    "",
    'globalThis.__streamMdxRestrictedNoEvalEffects.push("plain-source-expression")',
    'export const sideEffectMarker = (() => { globalThis.__streamMdxRestrictedNoEvalEffects.push("module-body"); return "executed"; })();',
    "",
    '`<Card title="inline-protected" />`',
    "",
    "```artifact",
    '<script>globalThis.__streamMdxRestrictedNoEvalEffects.push("artifact-script")</script>',
    '<Card title={globalThis.__streamMdxRestrictedNoEvalEffects.push("artifact-fence-tag")} />',
    '{Function("return globalThis.__streamMdxRestrictedNoEvalEffects.push(\'artifact-fence-expression\')")()}',
    "```",
    "",
    "```html-artifact",
    '<script>globalThis.__streamMdxRestrictedNoEvalEffects.push("html-artifact-script")</script>',
    '<iframe srcdoc="<script>globalThis.__streamMdxRestrictedNoEvalEffects.push(\'html-artifact-frame\')</script>"></iframe>',
    '{eval("globalThis.__streamMdxRestrictedNoEvalEffects.push(\'html-artifact-expression\')")}',
    "```",
    "",
    '<Card title="unfinished">incomplete authored body',
  ].join("\n");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const handle = createRef<StreamingMarkdownHandle>();
  const reportedErrors: Error[] = [];
  let worker: Worker | undefined;
  const findCard = (title: string) => Array.from(container.getElementsByTagName("output")).find((node) => node.getAttribute("data-restricted-card") === title);
  const findFileViewer = (path: string) => Array.from(container.getElementsByTagName("output")).find((node) => node.getAttribute("data-file-viewer-path") === path);
  let traps: EvaluationTraps | undefined;

  try {
    // Mount the public renderer and let its initial worker/reconciler setup settle before trapping.
    worker = createInlineEngineWorker() as unknown as Worker;
    await act(async () => {
      root.render(
        <StreamingMarkdown
          ref={handle}
          worker={worker}
          engine="worker"
          features={{ mdx: true, tables: false, html: false, math: false }}
          contentComponents={contentComponents}
          text="# restricted-entry-preflight"
          onError={(error) => reportedErrors.push(error)}
          caret={false}
        />,
      );
    });
    await waitFor(() => {
      const state = handle.current?.getState();
      return Boolean(
        state?.workerReady &&
        state.blocks.length > 0 &&
        state.blocks.every((block) => block.isFinalized) &&
        container.textContent?.includes("restricted-entry-preflight"),
      );
    }, "public renderer and inline worker preflight must settle before evaluation traps", () =>
      describeFailureState(handle, container, reportedErrors, effects, traps));
    await act(async () => { await handle.current?.waitForIdle(); });

    const evaluationTraps = installEvaluationTraps([
      { name: "globalThis", realm: globalThis },
      { name: "window", realm: dom.window as unknown as typeof globalThis },
    ]);
    traps = evaluationTraps;

    await act(async () => {
      root.render(
        <StreamingMarkdown
          ref={handle}
          worker={worker}
          engine="worker"
          features={{ mdx: true, tables: false, html: false, math: false }}
          contentComponents={contentComponents}
          text={source}
          onError={(error) => reportedErrors.push(error)}
          caret={false}
        />,
      );
    });

    await waitFor(() => {
      const state = handle.current?.getState();
      return Boolean(
        state?.workerReady &&
        state.blocks.length > 0 &&
        state.blocks.every((block) => block.isFinalized) &&
        findCard("literal-safe") &&
        findCard("unfinished") &&
        fileViewerCases.every(({ path }) => findFileViewer(path)),
      );
    }, "default restricted worker content must render and finalize while evaluation traps are active", () =>
      describeFailureState(handle, container, reportedErrors, effects, traps));
    await act(async () => { await handle.current?.waitForIdle(); });

    assert.deepEqual(effects, [], "authored expressions, source statements, and artifact-fence content stay inert");
    assert.deepEqual(reportedErrors, [], "the restricted public render completes without a processing error");
    assert.equal(Array.from(container.getElementsByTagName("output")).filter((node) => node.hasAttribute("data-restricted-card")).length, 2, "only registered valid and incomplete tags dispatch to the host component");
    assert.equal(findCard("literal-safe")?.getAttribute("data-count"), "7");
    assert.equal(findCard("literal-safe")?.getAttribute("data-enabled"), "true");
    assert.equal(findCard("unfinished")?.getAttribute("data-component-status"), "incomplete");

    const renderedPaths = Array.from(container.getElementsByTagName("output"))
      .filter((node) => node.hasAttribute("data-file-viewer-path"))
      .map((node) => node.getAttribute("data-file-viewer-path"));
    assert.deepEqual(renderedPaths.sort(), fileViewerCases.map(({ path }) => path).sort());
    for (const { path } of fileViewerCases) assert.equal(findFileViewer(path)?.textContent, "prod");
    assert.ok(
      fileViewerObservations.every((observation) =>
        observation.propsFrozen && observation.metaFrozen && observation.nestedFrozen),
      "admitted host props remain recursively frozen after worker transport",
    );

    const visible = container.textContent ?? "";
    assert.ok(visible.includes('<UnknownWidget title="unknown-authored-source" />'), "unknown component source remains authored text");
    assert.ok(visible.includes("<Card 12345>"), "malformed registered component source remains authored text");
    assert.ok(visible.includes('{globalThis.__streamMdxRestrictedNoEvalEffects.push("brace-expression")}'), "standalone JavaScript expression remains authored text");
    assert.ok(visible.includes("function-constructor") && visible.includes("eval-call") && visible.includes("async-constructor"), "dynamic-code constructor attempts remain authored text");
    assert.ok(visible.includes('{Function("return globalThis.__streamMdxRestrictedNoEvalEffects.push(\'artifact-fence-expression\')")()}'), "artifact-language fence retains its inert source");
    assert.ok(visible.includes('{eval("globalThis.__streamMdxRestrictedNoEvalEffects.push(\'html-artifact-expression\')")}'), "HTML artifact-language fence retains its inert source");
    assert.ok(Array.from(container.getElementsByTagName("code")).some((node) => node.textContent === '<Card title="inline-protected" />'), "inline code protects component-looking source");
    const fencedCode = Array.from(container.getElementsByTagName("pre")).flatMap((pre) =>
      Array.from(pre.getElementsByTagName("code")).map((node) => node.textContent ?? ""),
    );
    assert.ok(fencedCode.some((code) => code.includes('<script>globalThis.__streamMdxRestrictedNoEvalEffects.push("artifact-script")</script>') && code.includes("artifact-fence-tag")), "artifact fence body remains inert code");
    assert.ok(fencedCode.some((code) => code.includes('<script>globalThis.__streamMdxRestrictedNoEvalEffects.push("html-artifact-script")</script>') && code.includes("<iframe srcdoc=") && code.includes("html-artifact-frame")), "HTML artifact fence body remains inert code");
    assert.equal(container.getElementsByTagName("iframe").length, 0, "artifact source cannot mount an execution frame");
    assert.equal(container.getElementsByTagName("script").length, 0, "artifact source cannot mount a script");

    assert.deepEqual(evaluationTraps.attempts, [], "restricted processing and rendering must not access or invoke a dynamic code constructor");
  } finally {
    try {
      traps?.restore();
      await act(async () => { root.unmount(); });
    } finally {
      try {
        worker?.terminate();
      } finally {
        container.remove();
        for (const { target, descriptor } of priorEffectDescriptors) {
          if (descriptor) Object.defineProperty(target, effectProperty, descriptor);
          else Reflect.deleteProperty(target, effectProperty);
        }
        for (const [key, descriptor] of previousGlobals) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
        dom.window.close();
      }
    }
}
}

await testDefaultRestrictedEntryNeverEvaluatesContent();
console.log("default restricted entry evaluation-boundary test passed");
