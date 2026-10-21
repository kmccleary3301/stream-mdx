import assert from "node:assert";
import React from "react";
import * as ReactJsxDevRuntime from "react/jsx-dev-runtime";
import * as ReactJsxRuntime from "react/jsx-runtime";
import { compileTrustedMdxDocument } from "../src/mdx-compile";

interface TestCardProps {
  readonly count?: number;
  readonly children?: React.ReactNode;
}

type NativeChildFallback = (index: number) => React.ReactNode;
type NativeChildrenFactory = (fallback: NativeChildFallback) => React.ReactNode;
interface TestRegionProps {
  readonly children?: React.ReactNode | NativeChildrenFactory;
  readonly components?: Record<string, React.ElementType>;
}

interface EvaluatedModuleResult {
  readonly layout?: React.ComponentType<{ children?: React.ReactNode }> | null;
  readonly createRegions?: (
    props: { components?: Record<string, React.ElementType> },
  ) => Record<string, (props?: TestRegionProps) => React.ReactNode>;
  readonly shared?: unknown;
  readonly [key: string]: unknown;
}

async function evaluateCompiledFunctionBody(
  code: string,
  syncResolver: (specifier: string) => unknown,
  dynamicResolver: (specifier: string) => Promise<unknown>,
): Promise<EvaluatedModuleResult> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<EvaluatedModuleResult>;

  const runtime = {
    Fragment: React.Fragment,
    jsx: ReactJsxRuntime.jsx,
    jsxs: ReactJsxRuntime.jsxs,
    jsxDEV: ReactJsxDevRuntime.jsxDEV,
    _resolveSyncHostImport: syncResolver,
    _resolveDynamicHostImport: dynamicResolver,
  };

  const fn = new AsyncFunction(code);
  return fn(runtime);
}

async function testProvenanceSharedLexicalStateAndNativeOmission(): Promise<void> {
  const source = [
    'import { Card } from "host:widgets";',
    'import "host:side-effects";',
    "export const shared = 100;",
    "export default function CustomLayout({ children }) {",
    '  return <div className="layout">{children}</div>;',
    "}",
    "",
    "Native UTF-16 lead-in 😀.",
    "",
    "# Native Heading With Slug",
    "",
    '# Native Heading With <Card count={shared} owner="heading" />',
    "",
    "```typescript",
    'const nativeCode = "safe";',
    "```",
    "",
    "<Card count={shared} />",
    "",
    "<Card count={shared}>",
    "",
    "## Native flow heading",
    "",
    "```typescript",
    'const nativeFlowCode = "prepared";',
    "```",
    "",
    "| Native | flow table |",
    "| --- | --- |",
    "| table | child |",
    "",
    "</Card>",
    "",
    "",
    "Paragraph with {shared} inline expression.",
    "",
    '> Native quote with <Card count={shared} owner="quote" /> and {shared + 1}',
    "",
    '- Native list with <Card count={shared} owner="list" /> and {shared + 2}',
    "",
    "| Native table | MDX cell |",
    "| --- | --- |",
    '| native table cell | <Card count={shared} owner="table" /> |',
  ].join("\n");

  const artifact = await compileTrustedMdxDocument(source);

  // 1. Verify Compiler Identity reflects exact MDX 3.1.1 and transform options
  assert.ok(
    artifact.compilerIdentity.startsWith("stream-mdx-trusted:mdx3.1.1:recma-v3:sync-esm:native-flow-children"),
    `compilerIdentity must reflect exact mdx3.1.1 revision, got: ${artifact.compilerIdentity}`,
  );

  // 2. Verify dependencies extracted from AST
  assert.deepStrictEqual(
    artifact.dependencies,
    ["host:side-effects", "host:widgets"],
    "dependencies must be collected strictly from the AST",
  );

  // 3. Verify region provenance: only genuine MDX elements are render regions
  const renderRegions = artifact.regions.filter((r) => r.kind === "render");
  // Compiler MDAST may group adjacent authored ESM statements into one module region.
  // Their behavior is asserted below through imports, shared bindings, and layout.
  assert.ok(
    artifact.regions.some((region) => region.kind === "module"),
    "authored ESM must retain module provenance",
  );

  // Render regions include only authored MDX leaves, not their native ancestors.
  assert.deepStrictEqual(
    renderRegions.map((region) => source.slice(region.from, region.to)),
    [
      '<Card count={shared} owner="heading" />',
      "<Card count={shared} />",
      [
        "<Card count={shared}>",
        "",
        "## Native flow heading",
        "",
        "```typescript",
        'const nativeFlowCode = "prepared";',
        "```",
        "",
        "| Native | flow table |",
        "| --- | --- |",
        "| table | child |",
        "",
        "</Card>",
      ].join("\n"),
      "{shared}",
      '<Card count={shared} owner="quote" />',
      "{shared + 1}",
      '<Card count={shared} owner="list" />',
      "{shared + 2}",
      '<Card count={shared} owner="table" />',
    ],
    "each nested region must preserve its exact authored MDX leaf span",
  );
  assert.deepStrictEqual(
    renderRegions.map((region) => region.placement),
    ["inline", "flow", "flow", "inline", "inline", "inline", "inline", "inline", "inline"],
    "flow versus inline placement must come from the authored MDAST node type",
  );
  assert.deepStrictEqual(
    renderRegions.map((region) => region.rootElementName),
    [undefined, "Card", "Card", undefined, undefined, undefined, undefined, undefined, undefined],
    "only named compiler-authored flow JSX roots expose a native child slot",
  );
  assert.strictEqual(
    renderRegions.length,
    9,
    "only genuine MDX leaves in native containers must become render regions",
  );

  // 4. Prove synchronous static import side-effect ordering
  const resolutionLog: string[] = [];

  const Card: React.FC<TestCardProps> = ({ count }) => {
    return React.createElement("div", { "data-testid": "card", "data-count": count });
  };

  const syncResolver = (specifier: string): unknown => {
    resolutionLog.push(`sync:${specifier}`);
    if (specifier === "host:widgets") {
      return { Card };
    }
    if (specifier === "host:side-effects") {
      return { loaded: true };
    }
    throw new Error(`Unexpected import specifier: ${specifier}`);
  };

  const dynamicResolver = async (specifier: string): Promise<unknown> => {
    resolutionLog.push(`dynamic:${specifier}`);
    return {};
  };

  const evaluated = await evaluateCompiledFunctionBody(artifact.code, syncResolver, dynamicResolver);

  // Static imports must have resolved synchronously in source order during evaluation
  assert.deepStrictEqual(
    resolutionLog,
    ["sync:host:widgets", "sync:host:side-effects"],
    "static imports must resolve synchronously in source order",
  );

  // 5. Verify layout extraction
  assert.strictEqual(
    typeof evaluated.layout,
    "function",
    "authored export default CustomLayout must be captured as layout",
  );

  // 6. Verify single region factory executes binding prologue ONCE and returns region closures
  assert.strictEqual(
    typeof evaluated.createRegions,
    "function",
    "module must export createRegions factory function",
  );

  const regionClosures = evaluated.createRegions({ components: {} });

  // Native ancestors and code fences stay out of the region dictionary.
  assert.strictEqual(
    Object.keys(regionClosures).length,
    9,
    "region closures must contain only the exact authored MDX leaves",
  );
  assert.ok(regionClosures.region_0, "region_0 closure must exist");
  assert.ok(regionClosures.region_8, "region_8 closure must exist");
  assert.ok(regionClosures.region_7, "region_7 closure must exist");

  const closureForSource = (authoredLeaf: string): React.ReactNode => {
    const region = renderRegions.find(
      (candidate) => source.slice(candidate.from, candidate.to) === authoredLeaf,
    );
    assert.ok(region, `expected a render region for ${authoredLeaf}`);
    return regionClosures[region.key]({});
  };

  const renderedCardValue = closureForSource('<Card count={shared} owner="heading" />');
  const renderedCard = React.isValidElement(renderedCardValue) ? renderedCardValue : null;
  assert.ok(renderedCard, "a nested MDX leaf must evaluate to a valid React element");
  assert.strictEqual(
    renderedCard.type,
    Card,
    "the native heading ancestor must not be captured in the MDX closure",
  );
  assert.strictEqual(
    (renderedCard.props as Record<string, unknown>).count,
    100,
    "shared lexical binding (100) must be passed to the nested imported component",
  );
  const standaloneCardValue = closureForSource("<Card count={shared} />");
  const standaloneCard = React.isValidElement(standaloneCardValue) ? standaloneCardValue : null;
  assert.ok(standaloneCard, "a top-level MDX block must retain its own render closure");
  assert.strictEqual(standaloneCard.type, Card);
  assert.strictEqual((standaloneCard.props as Record<string, unknown>).count, 100);
  const nativeFlowSource = [
    "<Card count={shared}>",
    "",
    "## Native flow heading",
    "",
    "```typescript",
    'const nativeFlowCode = "prepared";',
    "```",
    "",
    "| Native | flow table |",
    "| --- | --- |",
    "| table | child |",
    "",
    "</Card>",
  ].join("\n");
  const nativeFlowRegion = renderRegions.find(
    (region) => source.slice(region.from, region.to) === nativeFlowSource,
  );
  assert.ok(nativeFlowRegion, "a flow JSX root containing native Markdown retains one exact owner span");
  const nativeChildren = React.createElement("h3", { "data-native-owner": "prepared" });
  const renderedNativeFlow = regionClosures[nativeFlowRegion.key]({ children: nativeChildren });
  assert.ok(React.isValidElement(renderedNativeFlow), "the flow root still evaluates to its authored host component");
  assert.strictEqual(renderedNativeFlow.type, Card);
  assert.strictEqual(
    (renderedNativeFlow.props as Record<string, unknown>).count,
    100,
    "the prepared-child override preserves authored component props",
  );
  assert.strictEqual(
    (renderedNativeFlow.props as Record<string, unknown>).children,
    nativeChildren,
    "the compiler-owned flow root accepts prepared native children without rebuilding its authored props",
  );
  assert.strictEqual(closureForSource("{shared}"), 100);
  for (const owner of ["quote", "list", "table"]) {
    const nestedCardValue = closureForSource(`<Card count={shared} owner="${owner}" />`);
    const nestedCard = React.isValidElement(nestedCardValue) ? nestedCardValue : null;
    assert.ok(nestedCard, `${owner} MDX leaf must evaluate to a React element`);
    assert.strictEqual(nestedCard.type, Card, `${owner} native ancestor must stay outside the closure`);
    assert.strictEqual(
      (nestedCard.props as Record<string, unknown>).owner,
      owner,
      `${owner} MDX leaf must retain its own authored component props`,
    );
  }
}

async function testNativeFlowChildrenOverrideIsLazy(): Promise<void> {
  const source = [
    'import { Card, bump, readTitle, readSpread, readChildAttribute } from "host:effects";',
    'export const undefined = "shadowed";',
    "",
    '<Card key="flow-card" title={readTitle()} children={readChildAttribute()} {...readSpread()}>',
    "",
    "{bump()}",
    "",
    '{"static child"}',
    "",
    "</Card>",

    "",
    '<Card key="empty-flow-card" children={readChildAttribute()} />',
  ].join("\n");

  for (const development of [false, true]) {
    let childEvaluations = 0;
    let titleEvaluations = 0;
    let spreadEvaluations = 0;
    let childAttributeEvaluations = 0;
    const Card: React.FC<{ readonly children?: React.ReactNode; readonly title?: string }> = ({ children }) =>
      React.createElement("section", null, children);
    const bump = (): number => ++childEvaluations;
    const readTitle = (): string => {
      titleEvaluations++;
      return "authored-title";
    };
    const readSpread = (): Record<string, string> => {
      spreadEvaluations++;
      return { "data-spread": "authored-spread" };
    };
    const readChildAttribute = (): string => {
      childAttributeEvaluations++;
      return "authored-child-attribute";
    };
    const artifact = await compileTrustedMdxDocument(source, { development });
    const flowRegion = artifact.regions.find(
      (region) =>
        region.kind === "render" &&
        "rootElementName" in region &&
        region.rootElementName === "Card",
    );
    assert.ok(flowRegion, "the standalone compiler-authored flow root must retain its exact region");
    assert.strictEqual(flowRegion.placement, "flow");
    const childRegion = artifact.regions.find(
      (region) =>
        region.kind === "render" &&
        source.slice(region.from, region.to) === "{bump()}",
    );
    assert.ok(childRegion, "the nested flow expression must remain independently addressable");
    assert.strictEqual(childRegion.placement, "flow");
    const emptyFlowRegion = artifact.regions.find(
      (region) =>
        region.kind === "render" &&
        source.slice(region.from, region.to) === '<Card key="empty-flow-card" children={readChildAttribute()} />',
    );
    assert.ok(emptyFlowRegion, "an empty flow root still retains its authored child attribute");

    const syncResolver = (specifier: string): unknown => {
      if (specifier === "host:effects") {
        return { Card, bump, readTitle, readSpread, readChildAttribute };
      }
      throw new Error(`Unknown: ${specifier}`);
    };
    const evaluated = await evaluateCompiledFunctionBody(
      artifact.code,
      syncResolver,
      async () => {
        throw new Error("Unexpected dynamic import");
      },
    );
    assert.ok(evaluated.createRegions);
    const closures = evaluated.createRegions({ components: {} });
    const nativeChildren = React.createElement("strong", null, "worker-prepared child");
    const overridden = closures[flowRegion.key]({ children: nativeChildren });
    const overriddenElement = React.isValidElement(overridden) ? overridden : null;
    assert.ok(overriddenElement);
    assert.strictEqual(overriddenElement.type, Card);
    assert.strictEqual(overriddenElement.key, "flow-card");
    assert.strictEqual(
      (overriddenElement.props as Record<string, unknown>).children,
      nativeChildren,
    );
    assert.strictEqual((overriddenElement.props as Record<string, unknown>).title, "authored-title");
    assert.strictEqual((overriddenElement.props as Record<string, unknown>)["data-spread"], "authored-spread");
    assert.strictEqual(childEvaluations, 0, "a prepared native override must not evaluate compiled children");
    assert.strictEqual(titleEvaluations, 1, "authored attributes must still be evaluated once");
    assert.strictEqual(spreadEvaluations, 1, "authored spreads must still be evaluated once");
    assert.strictEqual(
      childAttributeEvaluations,
      1,
      "an authored children attribute remains evaluated when compiled body children are replaced",
    );
    const partialOverride = closures[flowRegion.key]({
      children: (fallback) => [nativeChildren, fallback(1)],
    });
    const partialElement = React.isValidElement(partialOverride) ? partialOverride : null;
    assert.ok(partialElement);
    const partialChildren = (partialElement.props as Record<string, unknown>).children;
    assert.ok(Array.isArray(partialChildren));
    assert.strictEqual(partialChildren[0], nativeChildren, "the prepared first child keeps its native owner");
    assert.strictEqual(partialChildren[1], "static child", "an unowned direct child lazily uses compiled output");
    assert.strictEqual(childEvaluations, 0, "prepared and literal fallback children do not duplicate evaluation");
    assert.strictEqual(titleEvaluations, 2);
    assert.strictEqual(spreadEvaluations, 2);
    assert.strictEqual(childAttributeEvaluations, 2);

    const authored = closures[flowRegion.key]();
    const authoredElement = React.isValidElement(authored) ? authored : null;
    assert.ok(authoredElement);
    const authoredChildren = (authoredElement.props as Record<string, unknown>).children;
    assert.deepEqual(
      React.Children.toArray(authoredChildren),
      [1, "static child"],
      "without an override, all compiler-generated children are preserved",
    );
    assert.strictEqual(childEvaluations, 1);
    assert.strictEqual(titleEvaluations, 3);
    assert.strictEqual(spreadEvaluations, 3);
    assert.strictEqual(childAttributeEvaluations, 3);
    const emptyAuthored = closures[emptyFlowRegion.key]();
    const emptyAuthoredElement = React.isValidElement(emptyAuthored) ? emptyAuthored : null;
    assert.ok(emptyAuthoredElement);
    assert.strictEqual(
      (emptyAuthoredElement.props as Record<string, unknown>).children,
      "authored-child-attribute",
      "an empty flow root keeps its authored children prop",
    );
    assert.strictEqual(childAttributeEvaluations, 4);
  }
}

async function testCollisionFreeHelperEvaluation(): Promise<void> {
  // Source defines an authored variable that matches the resolver helper name
  const source = [
    'import { Item } from "host:items";',
    "export const _resolveSyncHostImport = 42;",
    "",
    "<Item val={_resolveSyncHostImport} />",
  ].join("\n");

  const artifact = await compileTrustedMdxDocument(source);
  const Item: React.FC<{ val?: number }> = ({ val }) => {
    return React.createElement("span", { "data-val": val });
  };

  const syncResolver = (specifier: string): unknown => {
    if (specifier === "host:items") {
      return { Item };
    }
    throw new Error(`Unknown: ${specifier}`);
  };

  const dynamicResolver = async (): Promise<unknown> => ({});

  // Evaluate: must execute without identifier collision or syntax conflict
  const evaluated = await evaluateCompiledFunctionBody(artifact.code, syncResolver, dynamicResolver);

  assert.strictEqual(
    evaluated._resolveSyncHostImport,
    42,
    "authored binding matching resolver name must remain intact and accessible",
  );

  assert.strictEqual(typeof evaluated.createRegions, "function");
  const closures = evaluated.createRegions({ components: {} });
  const renderedItem = closures.region_0();
  assert.ok(React.isValidElement(renderedItem));
  assert.strictEqual(
    (renderedItem.props as Record<string, unknown>).val,
    42,
    "collision-free helper must allow authored value 42 to flow to component",
  );
}

async function run(): Promise<void> {
  await testNativeFlowChildrenOverrideIsLazy();
  await testProvenanceSharedLexicalStateAndNativeOmission();
  await testCollisionFreeHelperEvaluation();
}

void run();
