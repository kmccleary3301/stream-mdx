import assert from "node:assert";

import { InlineParser } from "../src/inline-parser";
import { RNG } from "./helpers/rng";

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ";

function randomPlainText(rng: RNG, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += rng.pick(ALPHABET);
  }
  return out;
}

function runPlainTextPropertyTest(): void {
  const parser = new InlineParser({ maxCacheEntries: 0 });
  const rng = new RNG(4242);

  for (let i = 0; i < 200; i += 1) {
    const length = rng.int(1, 200);
    const input = randomPlainText(rng, length);
    const nodes = parser.parse(input, { cache: false });
    assert.strictEqual(nodes.length, 1, "expected a single text node for plain input");
    assert.strictEqual(nodes[0].kind, "text", "expected plain input to remain a text node");
    assert.strictEqual(nodes[0].text, input, "expected text node to preserve input");
  }
}

runPlainTextPropertyTest();
console.log("inline-parser-property test passed");
