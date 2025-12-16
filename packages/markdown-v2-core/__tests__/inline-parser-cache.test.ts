import assert from "node:assert";

import { InlineParser } from "../src/inline-parser";

async function main() {
  const parser = new InlineParser({ maxCacheEntries: 2 });

  const a1 = parser.parse("hello");
  const b1 = parser.parse("world");

  // Cached hits should preserve reference identity.
  const a2 = parser.parse("hello");
  assert.strictEqual(a2, a1, "expected inline parser to memoize identical inputs");

  // cache=false should bypass memoization without poisoning the memoized entry.
  const x1 = parser.parse("hello", { cache: false });
  const x2 = parser.parse("hello", { cache: false });
  assert.notStrictEqual(x2, x1, "expected cache=false to bypass memoization");
  const a3 = parser.parse("hello");
  assert.strictEqual(a3, a1, "expected cache=false parses to not overwrite memoized entries");

  // Touching "hello" should make "world" the oldest entry; adding a third key evicts it.
  parser.parse("zzz");
  const b2 = parser.parse("world");
  assert.notStrictEqual(b2, b1, "expected LRU eviction when cache exceeds maxCacheEntries");

  console.log("Inline parser cache test passed");
}

await main();
