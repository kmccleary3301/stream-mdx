import { compile as compileMdx } from "@mdx-js/mdx";
import type {
  Expression,
  FunctionDeclaration,
  Identifier,
  Node as EstreeNode,
  ObjectPattern,
  Program,
  Property,
  ReturnStatement,
  SimpleLiteral,
  VariableDeclaration,
} from "estree";
import type { Root } from "mdast";
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { TrustedMdxArtifact, TrustedMdxSourceRegion } from "@stream-mdx/core";
import { collectTrustedMdxSourceSpans, type TrustedMdxSourceSpan } from "./mdx-source-spans";

export const TRUSTED_MDX_COMPILER_REVISION = "stream-mdx-trusted:mdx3.1.1:recma-v3:sync-esm:native-flow-children-v5";




function getNodeSpan(node: object): { from: number; to: number } | null {
  if (
    "range" in node &&
    Array.isArray(node.range) &&
    Number.isInteger(node.range[0]) &&
    Number.isInteger(node.range[1])
  ) {
    return { from: node.range[0], to: node.range[1] };
  }
  if (
    "start" in node &&
    typeof node.start === "number" &&
    "end" in node &&
    typeof node.end === "number"
  ) {
    return { from: node.start, to: node.end };
  }
  return null;
}


function isExpressionNode(node: EstreeNode): node is Expression {
  switch (node.type) {
    case "ArrayExpression":
    case "ArrowFunctionExpression":
    case "AssignmentExpression":
    case "AwaitExpression":
    case "BinaryExpression":
    case "CallExpression":
    case "ChainExpression":
    case "ClassExpression":
    case "ConditionalExpression":
    case "FunctionExpression":
    case "Identifier":
    case "ImportExpression":
    case "Literal":
    case "LogicalExpression":
    case "MemberExpression":
    case "MetaProperty":
    case "NewExpression":
    case "ObjectExpression":
    case "SequenceExpression":
    case "TaggedTemplateExpression":
    case "TemplateLiteral":
    case "ThisExpression":
    case "UnaryExpression":
    case "UpdateExpression":
    case "YieldExpression":
      return true;
    default:
      return false;
  }
}

function findContainingMdxSpan(
  spans: readonly TrustedMdxSourceSpan[],
  from: number,
  to: number,
): number {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (spans[middle].from <= from) low = middle + 1;
    else high = middle;
  }
  const index = low - 1;
  return index >= 0 && from >= spans[index].from && to <= spans[index].to ? index : -1;
}

function isEstreeNode(value: unknown): value is EstreeNode {
  return (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function collectMdxRegionExpressions(
  node: EstreeNode,
  spans: readonly TrustedMdxSourceSpan[],
  expressions: Array<Expression | undefined>,
  expressionWidths: number[],
): void {
  const nodeSpan = getNodeSpan(node);
  if (nodeSpan && nodeSpan.to > nodeSpan.from) {
    const spanIndex = findContainingMdxSpan(spans, nodeSpan.from, nodeSpan.to);
    if (spanIndex !== -1) {
      const target = spans[spanIndex];
      if (
        target.kind === "jsx" &&
        node.type === "CallExpression" &&
        nodeSpan.from === target.from &&
        nodeSpan.to === target.to &&
        !expressions[spanIndex]
      ) {
        expressions[spanIndex] = node;
      } else if (target.kind === "expression" && isExpressionNode(node)) {
        const width = nodeSpan.to - nodeSpan.from;
        if (width > expressionWidths[spanIndex]) {
          expressions[spanIndex] = node;
          expressionWidths[spanIndex] = width;
        }
      }
    }
  }

  for (const [key, entry] of Object.entries(node)) {
    if (key === "loc" || key === "range" || key === "comments") continue;
    const value: unknown = entry;
    if (Array.isArray(value)) {
      for (const candidate of value) {
        const item: unknown = candidate;
        if (isEstreeNode(item)) {
          collectMdxRegionExpressions(item, spans, expressions, expressionWidths);
        }
      }
    } else if (isEstreeNode(value)) {
      collectMdxRegionExpressions(value, spans, expressions, expressionWidths);
    }
  }
}

/**
 * Replace only a compiler-authored flow root's children prop for a native override.
 * The fallback remains the untouched original JSX call. Native block owners supply an
 * internal factory that invokes only the original direct-child expressions needing fallback.
 */
function createFlowRootChildrenOverride(
  element: Expression,
  regionPropsName: string,
  flowChildCount: number,
  fallbackIndexName: string,
  singleChildJsxName?: string,
): Expression {
  if (flowChildCount === 0) return element;
  if (element.type !== "CallExpression" || element.arguments.length < 2) {
    throw new Error("Unable to prepare native children for a compiler-authored flow JSX root.");
  }
  const propsArgument = element.arguments[1];
  if (!propsArgument || propsArgument.type !== "ObjectExpression") {
    throw new Error("Unable to prepare native children for compiler-generated JSX props.");
  }

  let childrenPropertyIndex = -1;
  for (let index = 0; index < propsArgument.properties.length; index++) {
    const property = propsArgument.properties[index];
    if (property.type !== "Property") continue;
    if (
      (property.key.type === "Identifier" && !property.computed && property.key.name === "children") ||
      (property.key.type === "Literal" && property.key.value === "children")
    ) {
      childrenPropertyIndex = index;
    }
  }

  const nativeChildren = (): Expression => ({
    type: "MemberExpression",
    object: { type: "Identifier", name: regionPropsName },
    property: { type: "Identifier", name: "children" },
    computed: false,
    optional: false,
  });
  const propsProperties = propsArgument.properties.slice();
  const fallbackChildValues: Expression[] = [];
  if (flowChildCount > 0) {
    const childrenProperty = propsProperties[childrenPropertyIndex];
    if (childrenPropertyIndex === -1 || !childrenProperty || childrenProperty.type !== "Property") {
      throw new Error("Unable to map compiler-generated flow children to native child fallbacks.");
    }
    const childValues =
      childrenProperty.value.type === "ArrayExpression"
        ? childrenProperty.value.elements
        : [childrenProperty.value];
    if (childValues.length !== flowChildCount) {
      throw new Error("Compiler-generated flow children do not match their authored MDAST spans.");
    }
    for (const childValue of childValues) {
      if (!childValue || childValue.type === "SpreadElement" || !isExpressionNode(childValue)) {
        throw new Error("Unable to create a lazy fallback for a compiler-generated flow child.");
      }
      fallbackChildValues.push(childValue);
    }
  }

  let fallbackBody: Expression = {
    type: "UnaryExpression",
    operator: "void",
    argument: { type: "Literal", value: 0 },
    prefix: true,
  };
  for (let index = fallbackChildValues.length - 1; index >= 0; index--) {
    fallbackBody = {
      type: "ConditionalExpression",
      test: {
        type: "BinaryExpression",
        operator: "===",
        left: { type: "Identifier", name: fallbackIndexName },
        right: { type: "Literal", value: index },
      },
      consequent: fallbackChildValues[index],
      alternate: fallbackBody,
    };
  }
  const fallbackFactory: Expression = {
    type: "ArrowFunctionExpression",
    params: [{ type: "Identifier", name: fallbackIndexName }],
    body: fallbackBody,
    expression: true,
  };
  const childrenOverride = (): Expression => {
    const nativeChildrenValue = nativeChildren();
    return {
      type: "ConditionalExpression",
      test: {
        type: "BinaryExpression",
        operator: "===",
        left: {
          type: "UnaryExpression",
          operator: "typeof",
          argument: nativeChildren(),
          prefix: true,
        },
        right: { type: "Literal", value: "function" },
      },
      consequent: {
        type: "CallExpression",
        callee: nativeChildrenValue,
        arguments: [fallbackFactory],
        optional: false,
      },
      alternate: nativeChildren(),
    };
  };

  if (flowChildCount > 0 && childrenPropertyIndex !== -1) {
    const childrenProperty = propsProperties[childrenPropertyIndex];
    if (childrenProperty.type !== "Property") {
      throw new Error("Unable to replace compiler-generated JSX children.");
    }
    propsProperties[childrenPropertyIndex] = {
      ...childrenProperty,
      value: childrenOverride(),
    };
  } else {
    propsProperties.push({
      type: "Property",
      key: { type: "Identifier", name: "children" },
      value: childrenOverride(),
      kind: "init",
      method: false,
      shorthand: false,
      computed: false,
    });
  }

  const overriddenArguments = element.arguments.slice();
  overriddenArguments[1] = { ...propsArgument, properties: propsProperties };
  let overriddenCallee = element.callee;
  if (element.callee.type === "Identifier" && element.callee.name.endsWith("jsxs")) {
    if (!singleChildJsxName) {
      throw new Error("Unable to select the single-child JSX runtime helper for prepared flow children.");
    }
    overriddenCallee = { ...element.callee, name: singleChildJsxName };
  } else if (element.callee.type === "Identifier" && element.callee.name.endsWith("jsxDEV")) {
    if (overriddenArguments.length < 4) {
      throw new Error("The compiler's development JSX call has no static-children argument.");
    }
    overriddenArguments[3] = { type: "Literal", value: false };
  } else if (element.callee.type !== "Identifier" || !element.callee.name.endsWith("jsx")) {
    throw new Error("The compiler's flow root uses an unsupported JSX runtime helper.");
  }
  const overriddenElement: Expression = {
    ...element,
    callee: overriddenCallee,
    arguments: overriddenArguments,
  };
  return {
    type: "ConditionalExpression",
    test: {
      type: "BinaryExpression",
      operator: "!==",
      left: nativeChildren(),
      right: {
        type: "UnaryExpression",
        operator: "void",
        argument: { type: "Literal", value: 0 },
        prefix: true,
      },
    },
    consequent: overriddenElement,
    alternate: element,
  };
}

function collectAllIdentifierNames(node: EstreeNode, names: Set<string>): void {
  if (node.type === "Identifier") {
    names.add(node.name);
    return;
  }
  for (const [key, entry] of Object.entries(node)) {
    if (key === "loc" || key === "range" || key === "comments") continue;
    const value: unknown = entry;
    if (Array.isArray(value)) {
      for (const candidate of value) {
        const item: unknown = candidate;
        if (isEstreeNode(item)) {
          collectAllIdentifierNames(item, names);
        }
      }
    } else if (isEstreeNode(value)) {
      collectAllIdentifierNames(value, names);
    }
  }
}

function generateCollisionFreeIdentifier(base: string, existingNames: Set<string>): string {
  if (!existingNames.has(base)) {
    existingNames.add(base);
    return base;
  }
  let counter = 1;
  while (existingNames.has(`${base}_${counter}`)) {
    counter += 1;
  }
  const uniqueName = `${base}_${counter}`;
  existingNames.add(uniqueName);
  return uniqueName;
}
function ensureRuntimeHelperBinding(
  tree: Program,
  helperName: "jsx",
  existingNames: Set<string>,
): string {
  let runtimePattern: ObjectPattern | undefined;
  for (const statement of tree.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      const initializer = declaration.init;
      if (
        declaration.id.type === "ObjectPattern" &&
        initializer?.type === "MemberExpression" &&
        initializer.computed &&
        initializer.object.type === "Identifier" &&
        initializer.object.name === "arguments" &&
        initializer.property.type === "Literal" &&
        (initializer.property as SimpleLiteral).value === 0
      ) {
        runtimePattern = declaration.id;
        break;
      }
    }
    if (runtimePattern) break;
  }
  if (!runtimePattern) {
    throw new Error("Unable to find the function-body JSX runtime bindings for prepared flow children.");
  }

  for (const property of runtimePattern.properties) {
    if (property.type !== "Property") continue;
    const importedName =
      property.key.type === "Identifier" && !property.computed
        ? property.key.name
        : property.key.type === "Literal"
          ? String((property.key as SimpleLiteral).value)
          : null;
    if (importedName !== helperName) continue;
    if (property.value.type !== "Identifier") {
      throw new Error(`The compiler's ${helperName} runtime binding is not a local identifier.`);
    }
    return property.value.name;
  }

  const localName = generateCollisionFreeIdentifier("_trustedMdxSingleChildJsx", existingNames);
  runtimePattern.properties.push({
    type: "Property",
    key: { type: "Identifier", name: helperName },
    value: { type: "Identifier", name: localName },
    kind: "init",
    method: false,
    shorthand: false,
    computed: false,
  });
  return localName;
}

function extractSpecifierFromNode(node: Expression): { specifier: string; specifierNode: Expression } | null {
  if (node.type === "CallExpression") {
    const callee = node.callee as Identifier;
    if (callee.name === "_resolveDynamicMdxSpecifier" && node.arguments.length > 0) {
      const arg = node.arguments[0] as Expression;
      if (arg.type === "Literal" && typeof (arg as SimpleLiteral).value === "string") {
        return {
          specifier: (arg as SimpleLiteral).value as string,
          specifierNode: arg,
        };
      }
      return { specifier: "", specifierNode: arg };
    }
  }
  if (node.type === "Literal" && typeof (node as SimpleLiteral).value === "string") {
    return {
      specifier: (node as SimpleLiteral).value as string,
      specifierNode: node,
    };
  }
  return null;
}

function lowerDynamicImportExpressions(
  node: EstreeNode,
  dynamicResolverName: string,
): EstreeNode {
  if (node.type === "ImportExpression") {
    const extracted = extractSpecifierFromNode(node.source);
    const source = extracted ? extracted.specifierNode : node.source;
    const loweredSource = lowerDynamicImportExpressions(source, dynamicResolverName);
    if (!isExpressionNode(loweredSource)) {
      throw new Error("Unable to lower a dynamic MDX import specifier to an expression.");
    }
    const resolverCall: EstreeNode = {
      type: "CallExpression",
      callee: { type: "Identifier", name: dynamicResolverName },
      arguments: [loweredSource],
      optional: false,
      loc: node.loc,
      range: node.range,
    };
    const sourceSpan = getNodeSpan(node);
    if (sourceSpan && !node.range) {
      Object.assign(resolverCall, { start: sourceSpan.from, end: sourceSpan.to });
    }
    return resolverCall;
  }

  for (const [key, entry] of Object.entries(node)) {
    if (key === "loc" || key === "range" || key === "comments") continue;
    const value: unknown = entry;
    if (Array.isArray(value)) {
      const childNodes: unknown[] = value;
      for (let index = 0; index < childNodes.length; index++) {
        const candidate: unknown = childNodes[index];
        if (isEstreeNode(candidate)) {
          const lowered = lowerDynamicImportExpressions(candidate, dynamicResolverName);
          if (lowered !== candidate) childNodes[index] = lowered;
        }
      }
    } else if (isEstreeNode(value)) {
      const lowered = lowerDynamicImportExpressions(value, dynamicResolverName);
      if (lowered !== value) Object.assign(node, { [key]: lowered });
    }
  }

  return node;
}


/**
 * Compiles a full authored MDX document using real MDX3 with an owned recma AST transform.
 *
 * Enforces:
 * - Exact UTF-16 authored provenance captured from remark MDAST before lowering.
 * - Native headings and code fences retain native status even with rehype-slug IDs or Shiki classNames.
 * - Extracts only genuine MDX regions, transforming `_createMdxContent` into a single factory function
 *   retaining the entire binding prologue ONCE (avoiding O(regions * bindings) duplication).
 * - Lowers compiler-generated static imports to SYNCHRONOUS resolver calls without awaiting namespace.
 * - Authored dynamic imports retain Promise semantics via an explicit bound resolver.
 * - Generates collision-free helper identifiers derived from AST names.
 * - Exports document layout alongside isolated region closures.
 */
export async function compileTrustedMdxDocument(
  source: string,
  options?: { development?: boolean },
): Promise<TrustedMdxArtifact> {
  const dependencies = new Set<string>();
  const regions: TrustedMdxSourceRegion[] = [];
  const mdxRegionSpans: TrustedMdxSourceSpan[] = [];

  // Remark Plugin: retain exact authored MDX leaf provenance before lowering.
  const remarkMdxProvenance = () => {
    return (tree: Root) => {
      mdxRegionSpans.push(...collectTrustedMdxSourceSpans(tree, source.length));

      for (const child of tree.children) {
        const pos = child.position;
        if (
          child.type === "mdxjsEsm" &&
          pos &&
          typeof pos.start.offset === "number" &&
          Number.isInteger(pos.start.offset) &&
          typeof pos.end.offset === "number" &&
          Number.isInteger(pos.end.offset) &&
          pos.start.offset >= 0 &&
          pos.end.offset <= source.length &&
          pos.start.offset < pos.end.offset
        ) {
          regions.push({
            key: `module_${pos.start.offset}_${pos.end.offset}`,
            from: pos.start.offset,
            to: pos.end.offset,
            kind: "module",
          });
          continue;
        }
      }
      mdxRegionSpans.sort((left, right) => left.from - right.from || left.to - right.to);
    };
  };

  // Recma Plugin: transform ESTree to lower imports and extract region closures
  const recmaTrustedPlugin = () => {
    return (tree: Program) => {
      const astNames = new Set<string>();
      collectAllIdentifierNames(tree, astNames);

      const syncResolverName = generateCollisionFreeIdentifier("_resolveSyncHostImport", astNames);
      const dynamicResolverName = generateCollisionFreeIdentifier("_resolveDynamicHostImport", astNames);
      const regionPropsName = generateCollisionFreeIdentifier("_trustedMdxRegionProps", astNames);
      const fallbackIndexName = generateCollisionFreeIdentifier("_trustedMdxChildIndex", astNames);

      // 1. Lower compiler-generated static imports to SYNCHRONOUS resolver calls
      for (const stmt of tree.body) {
        if (stmt.type === "VariableDeclaration") {
          for (const decl of stmt.declarations) {
            if (decl.init && decl.init.type === "AwaitExpression") {
              const awaitArg = decl.init.argument;
              if (awaitArg.type === "ImportExpression") {
                const extracted = extractSpecifierFromNode(awaitArg.source);
                if (extracted && extracted.specifier) {
                  dependencies.add(extracted.specifier);
                }
                const specNode = extracted ? extracted.specifierNode : awaitArg.source;
                // Replace AwaitExpression with synchronous CallExpression (no await, no platform yield)
                decl.init = {
                  type: "CallExpression",
                  callee: { type: "Identifier", name: syncResolverName },
                  arguments: [specNode],
                  optional: false,
                };
              }
            }
          }
        } else if (stmt.type === "ExpressionStatement") {
          if (stmt.expression.type === "AwaitExpression") {
            const awaitArg = stmt.expression.argument;
            if (awaitArg.type === "ImportExpression") {
              const extracted = extractSpecifierFromNode(awaitArg.source);
              if (extracted && extracted.specifier) {
                dependencies.add(extracted.specifier);
              }
              const specNode = extracted ? extracted.specifierNode : awaitArg.source;
              // Replace AwaitExpression with synchronous CallExpression
              stmt.expression = {
                type: "CallExpression",
                callee: { type: "Identifier", name: syncResolverName },
                arguments: [specNode],
                optional: false,
              };
            }
          }
        }
      }

      // 2. Lower authored dynamic imports through the host resolver, then remove MDX-only URL support.
      for (const stmt of tree.body) {
        lowerDynamicImportExpressions(stmt, dynamicResolverName);
      }

      const hasDynamicMdxSpecifierHelper = tree.body.some(
        (stmt) => stmt.type === "FunctionDeclaration" && stmt.id?.name === "_resolveDynamicMdxSpecifier",
      );
      if (hasDynamicMdxSpecifierHelper) {
        const importMetaUrlBootstrap: typeof tree.body = [];
        tree.body = tree.body.filter((stmt) => {
          if (stmt.type === "FunctionDeclaration" && stmt.id?.name === "_resolveDynamicMdxSpecifier") {
            return false;
          }
          if (
            stmt.type === "VariableDeclaration" &&
            stmt.declarations.some((declaration) => {
              const initializer = declaration.init;
              return (
                declaration.id.type === "Identifier" &&
                declaration.id.name === "_importMetaUrl" &&
                initializer?.type === "MemberExpression" &&
                !initializer.computed &&
                initializer.property.type === "Identifier" &&
                initializer.property.name === "baseUrl" &&
                initializer.object.type === "MemberExpression" &&
                initializer.object.computed &&
                initializer.object.object.type === "Identifier" &&
                initializer.object.object.name === "arguments" &&
                initializer.object.property.type === "Literal" &&
                (initializer.object.property as SimpleLiteral).value === 0
              );
            })
          ) {
            importMetaUrlBootstrap.push(stmt);
            return false;
          }
          if (
            stmt.type === "IfStatement" &&
            stmt.test.type === "UnaryExpression" &&
            stmt.test.operator === "!" &&
            stmt.test.argument.type === "Identifier" &&
            stmt.test.argument.name === "_importMetaUrl" &&
            stmt.consequent.type === "ThrowStatement" &&
            stmt.consequent.argument.type === "NewExpression" &&
            stmt.consequent.argument.callee.type === "Identifier" &&
            stmt.consequent.argument.callee.name === "Error" &&
            stmt.consequent.argument.arguments[0]?.type === "Literal" &&
            (stmt.consequent.argument.arguments[0] as SimpleLiteral).value ===
              "Unexpected missing `options.baseUrl` needed to support `export … from`, `import`, or `import.meta.url` when generating `function-body`"
          ) {
            importMetaUrlBootstrap.push(stmt);
            return false;
          }
          return true;
        });

        const remainingNames = new Set<string>();
        for (const stmt of tree.body) collectAllIdentifierNames(stmt, remainingNames);
        if (remainingNames.has("_importMetaUrl")) {
          tree.body.unshift(...importMetaUrlBootstrap);
        }
      }

      // 3. Inject synchronous and dynamic resolver helpers in the module prologue.
      const resolverPrologueStmt: VariableDeclaration = {
        type: "VariableDeclaration",
        kind: "const",
        declarations: [
          {
            type: "VariableDeclarator",
            id: { type: "Identifier", name: syncResolverName },
            init: {
              type: "MemberExpression",
              object: {
                type: "MemberExpression",
                object: { type: "Identifier", name: "arguments" },
                property: { type: "Literal", value: 0 },
                computed: true,
                optional: false,
              },
              property: { type: "Identifier", name: "_resolveSyncHostImport" },
              computed: false,
              optional: true,
            },
          },
          {
            type: "VariableDeclarator",
            id: { type: "Identifier", name: dynamicResolverName },
            init: {
              type: "MemberExpression",
              object: {
                type: "MemberExpression",
                object: { type: "Identifier", name: "arguments" },
                property: { type: "Literal", value: 0 },
                computed: true,
                optional: false,
              },
              property: { type: "Identifier", name: "_resolveDynamicHostImport" },
              computed: false,
              optional: true,
            },
          },
        ],
      };

      // Place right after JSX runtime destructuring (index 1)
      tree.body.splice(1, 0, resolverPrologueStmt);

      // 4. Detect authored document layout
      const hasAuthoredLayout = tree.body.some((stmt) => {
        if (stmt.type === "VariableDeclaration") {
          return stmt.declarations.some((d) => (d.id as Identifier).name === "MDXLayout");
        }
        if (stmt.type === "FunctionDeclaration") {
          return stmt.id?.name === "MDXLayout";
        }
        return false;
      });

      // 5. Transform _createMdxContent into ONE region factory function
      const createContentFn = tree.body.find(
        (stmt): stmt is FunctionDeclaration =>
          stmt.type === "FunctionDeclaration" && stmt.id?.name === "_createMdxContent",
      );

      if (createContentFn && createContentFn.body) {
        const bodyStmts = createContentFn.body.body;
        const returnStmtIndex = bodyStmts.findIndex((s): s is ReturnStatement => s.type === "ReturnStatement");

        if (returnStmtIndex !== -1) {
          const returnStmt = bodyStmts[returnStmtIndex] as ReturnStatement;
          const returnArg = returnStmt.argument;

          const regionExpressions: Array<Expression | undefined> = new Array(mdxRegionSpans.length);
          const expressionWidths = new Array<number>(mdxRegionSpans.length).fill(-1);
          if (returnArg) {
            collectMdxRegionExpressions(returnArg, mdxRegionSpans, regionExpressions, expressionWidths);
          }

          // Build closures only for exact authored MDX leaves, never their native ancestors.
          const regionClosures: Property[] = [];
          let regionIndex = 0;
          let singleChildJsxName: string | undefined;

          for (let spanIndex = 0; spanIndex < mdxRegionSpans.length; spanIndex++) {
            const elem = regionExpressions[spanIndex];
            const span = mdxRegionSpans[spanIndex];
            if (!elem) {
              throw new Error(
                `Unable to map authored MDX ${span.kind} at ${span.from}..${span.to} to a render expression.`,
              );
            }
            if (span.hasFlowChildren && span.flowChildren === undefined) {
              throw new Error("Compiler-authored flow children have no exact MDAST source spans.");
            }
            if (
              span.rootElementName !== undefined &&
              elem.type === "CallExpression" &&
              elem.callee.type === "Identifier" &&
              elem.callee.name.endsWith("jsxs")
            ) {
              singleChildJsxName ??= ensureRuntimeHelperBinding(tree, "jsx", astNames);
            }

            const regionKey = `region_${regionIndex++}`;
            const regionBody: Expression =
              span.rootElementName === undefined
                ? elem
                : createFlowRootChildrenOverride(
                    elem,
                    regionPropsName,
                    span.flowChildren?.length ?? 0,
                    fallbackIndexName,
                    singleChildJsxName,
                  );

            regions.push({
              key: regionKey,
              from: span.from,
              to: span.to,
              kind: "render",
              placement: span.placement,
              ...(span.rootElementName === undefined ? {} : { rootElementName: span.rootElementName }),
              ...(span.flowChildren === undefined ? {} : { flowChildren: span.flowChildren }),
            });

            regionClosures.push({
              type: "Property",
              key: { type: "Literal", value: regionKey },
              value: {
                type: "ArrowFunctionExpression",
                params: span.rootElementName === undefined
                  ? []
                  : [{
                      type: "AssignmentPattern",
                      left: { type: "Identifier", name: regionPropsName },
                      right: { type: "ObjectExpression", properties: [] },
                    }],
                body: regionBody,
                expression: true,
              },
              kind: "init",
              method: false,
              shorthand: false,
              computed: false,
            });

          }

          // Transform return statement into returning the region closures dictionary
          bodyStmts[returnStmtIndex] = {
            type: "ReturnStatement",
            argument: {
              type: "ObjectExpression",
              properties: regionClosures,
            },
          };
        }
      }

      // 6. Update final module ReturnStatement with layout and region factory
      const returnExportStmt = tree.body.find(
        (stmt): stmt is ReturnStatement => stmt.type === "ReturnStatement",
      );
      if (returnExportStmt && returnExportStmt.argument?.type === "ObjectExpression") {
        // Filter out default whole-document renderer MDXContent
        returnExportStmt.argument.properties = returnExportStmt.argument.properties.filter((prop) => {
          if (prop.type === "Property") {
            const key = prop.key;
            if (key.type === "Identifier" && key.name === "default") {
              return false;
            }
            if (key.type === "Literal" && key.value === "default") {
              return false;
            }
          }
          return true;
        });

        const returnedProperties = returnExportStmt.argument.properties;

        // Export layout
        returnedProperties.push({
          type: "Property",
          key: { type: "Identifier", name: "layout" },
          value: hasAuthoredLayout ? { type: "Identifier", name: "MDXLayout" } : { type: "Literal", value: null },
          kind: "init",
          method: false,
          shorthand: false,
          computed: false,
        });

        // Export createRegions factory
        returnedProperties.push({
          type: "Property",
          key: { type: "Identifier", name: "createRegions" },
          value: { type: "Identifier", name: "_createMdxContent" },
          kind: "init",
          method: false,
          shorthand: false,
          computed: false,
        });
      }
    };
  };

  const runtimeEnv = typeof process === "undefined" ? undefined : process.env;
  const isDev = options?.development ?? runtimeEnv?.NODE_ENV === "development";
  const compilerIdentity = `${TRUSTED_MDX_COMPILER_REVISION}:${isDev ? "dev" : "prod"}`;

  const compiled = await compileMdx(source, {
    outputFormat: "function-body",
    development: isDev,
    remarkPlugins: [remarkGfm, remarkMath, remarkMdxProvenance],
    rehypePlugins: [
      rehypeSlug,
      [
        rehypeKatex,
        {
          throwOnError: false,
          errorColor: "#cc0000",
          strict: false,
        },
      ],
    ],
    recmaPlugins: [recmaTrustedPlugin],
    jsxImportSource: "react",
  });

  // Sort regions deterministically by source offset
  regions.sort((a, b) => a.from - b.from || a.to - b.to);

  return Object.freeze({
    code: String(compiled),
    dependencies: Object.freeze(Array.from(dependencies).sort()),
    regions: Object.freeze(regions),
    compilerIdentity,
  });
}

