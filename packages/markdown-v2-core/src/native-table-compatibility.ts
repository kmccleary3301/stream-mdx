import { Table, parser as nativeBaseParser } from "@lezer/markdown";
import type {
  BlockContext,
  BlockParser,
  Element,
  LeafBlock,
  LeafBlockParser,
  MarkdownParser,
} from "@lezer/markdown";

type NativeBlockHandler = NonNullable<BlockParser["parse"]>;
type NativeEndLeaf = NonNullable<BlockParser["endLeaf"]>;
type NativeLeafFactory = NonNullable<BlockParser["leaf"]>;

// Private adapter for the pinned @lezer/markdown 1.6.1 parser tables and Table leaf state.
// Dependency upgrades must re-establish these identities with native-table-compatibility.test.ts.
type NativeParserInternals = MarkdownParser & {
  readonly blockNames: readonly string[];
  readonly blockParsers: readonly (NativeBlockHandler | undefined)[];
  readonly endLeafBlock: readonly NativeEndLeaf[];
  readonly leafBlockParsers: readonly (NativeLeafFactory | undefined)[];
};

type NativeTableLeafParser = LeafBlockParser & {
  rows: false | null | Element[];
};

interface NativeParserCapabilities {
  readonly tablesEnabled: boolean;
  readonly defaultSetextFactory: boolean;
  readonly defaultHorizontalRule: boolean;
  readonly nativeTableEndLeafInstalled: boolean;
}

const nativeInternals = nativeBaseParser as NativeParserInternals;

function nativeLeafFactory(name: string): NativeLeafFactory {
  const index = nativeInternals.blockNames.indexOf(name);
  const factory = index < 0 ? undefined : nativeInternals.leafBlockParsers[index];
  if (!factory) throw new Error(`@lezer/markdown native ${name} leaf factory is unavailable`);
  return factory;
}

function nativeBlockHandler(name: string): NativeBlockHandler {
  const index = nativeInternals.blockNames.indexOf(name);
  const handler = index < 0 ? undefined : nativeInternals.blockParsers[index];
  if (!handler) throw new Error(`@lezer/markdown native ${name} block handler is unavailable`);
  return handler;
}

function isNativeTableLeafParser(parser: LeafBlockParser): parser is NativeTableLeafParser {
  return "rows" in parser &&
    (parser.rows === false || parser.rows === null || Array.isArray(parser.rows));
}

const nativeTableSpec = Table.parseBlock?.find((spec) => spec.name === "Table");
if (!nativeTableSpec?.leaf || !nativeTableSpec.endLeaf) {
  throw new Error("@lezer/markdown public Table config has no native Table leaf/endLeaf rules");
}

const nativeTableLeafFactory = nativeTableSpec.leaf;
const nativeTableEndLeaf = nativeTableSpec.endLeaf;
const nativeTableBefore = nativeTableSpec.before;
const nativeSetextLeafFactory = nativeLeafFactory("SetextHeading");
const nativeHorizontalRuleHandler = nativeBlockHandler("HorizontalRule");

/** Builds the private Table leaf adapter used by createBlockCompatibilityExtension. */
export function createNativeTableCompatibilityRule(): BlockParser {
  const nativeTables = new WeakSet<NativeTableLeafParser>();
  const setextHandled = new WeakSet<NativeTableLeafParser>();
  const parserCapabilities = new WeakMap<MarkdownParser, NativeParserCapabilities>();
  let nativeSetextPrototype: object | undefined;

  function getParserCapabilities(parser: MarkdownParser): NativeParserCapabilities {
    const cached = parserCapabilities.get(parser);
    if (cached) return cached;

    const internals = parser as NativeParserInternals;
    const tableIndex = internals.blockNames.indexOf("Table");
    const setextIndex = internals.blockNames.indexOf("SetextHeading");
    const horizontalRuleIndex = internals.blockNames.indexOf("HorizontalRule");
    const tableFactory = tableIndex < 0 ? undefined : internals.leafBlockParsers[tableIndex];
    const setextFactory = setextIndex < 0 ? undefined : internals.leafBlockParsers[setextIndex];
    const horizontalRuleHandler = horizontalRuleIndex < 0 ? undefined : internals.blockParsers[horizontalRuleIndex];
    const result: NativeParserCapabilities = {
      tablesEnabled: parser.nodeSet.types.some((type) => type.name === "Table") && tableFactory !== undefined,
      defaultSetextFactory: setextFactory === nativeSetextLeafFactory,
      defaultHorizontalRule: horizontalRuleHandler === nativeHorizontalRuleHandler,
      nativeTableEndLeafInstalled: internals.endLeafBlock.includes(nativeTableEndLeaf),
    };
    parserCapabilities.set(parser, result);
    return result;
  }

  function getNativeSetextPrototype(cx: BlockContext, leaf: LeafBlock): object {
    if (nativeSetextPrototype) return nativeSetextPrototype;
    const instance = nativeSetextLeafFactory(cx, leaf);
    if (!instance) throw new Error("@lezer/markdown default SetextHeading leaf factory returned no parser");
    const prototype = Object.getPrototypeOf(instance);
    if (prototype === null) throw new Error("@lezer/markdown default SetextHeading parser has no prototype");
    nativeSetextPrototype = prototype;
    return prototype;
  }

  return {
    name: "Table",
    before: nativeTableBefore,
    leaf(cx, leaf) {
      if (!getParserCapabilities(cx.parser).tablesEnabled) return null;
      const instance = nativeTableLeafFactory(cx, leaf);
      if (!instance) return null;
      if (!isNativeTableLeafParser(instance)) {
        throw new Error("@lezer/markdown native Table leaf parser has an unexpected rows state");
      }

      nativeTables.add(instance);
      const nativeNextLine = instance.nextLine;
      instance.nextLine = function (cx, line, leaf) {
        const finished = nativeNextLine.call(instance, cx, line, leaf);
        if (Array.isArray(instance.rows) && !setextHandled.has(instance)) {
          if (getParserCapabilities(cx.parser).defaultSetextFactory) {
            const setextPrototype = getNativeSetextPrototype(cx, leaf);
            for (let index = leaf.parsers.length - 1; index >= 0; index--) {
              if (Object.getPrototypeOf(leaf.parsers[index]) === setextPrototype) {
                leaf.parsers.splice(index, 1);
              }
            }
          }
          setextHandled.add(instance);
        }
        return finished;
      };
      return instance;
    },
    endLeaf(cx, line, leaf) {
      const capabilities = getParserCapabilities(cx.parser);
      if (!capabilities.tablesEnabled) return false;

      // Keep the public Table config's paragraph-to-table interruption rule when it is not already installed.
      if (!capabilities.nativeTableEndLeafInstalled && nativeTableEndLeaf(cx, line, leaf)) return true;
      if (line.next !== 45 || !capabilities.defaultHorizontalRule) return false;
      const admittedNativeTable = leaf.parsers.some((parser) =>
        isNativeTableLeafParser(parser) && nativeTables.has(parser) && Array.isArray(parser.rows));
      if (!admittedNativeTable) return false;

      // line.basePos is after owning list/quote markers and keeps the logical line's indentation.
      const tree = nativeBaseParser.parse(line.text.slice(line.basePos));
      const block = tree.topNode.firstChild;
      return block?.type.name === "HorizontalRule" && block.nextSibling === null;
    },
  };
}
