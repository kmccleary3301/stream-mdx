import assert from "node:assert";

import { characterEntities } from "character-entities";
import { decodeNamedCharacterReference as upstreamDefaultEntry } from "decode-named-character-reference";

import { decodeNamedCharacterReference } from "../src/entities/named-character-reference";

// In Node the upstream package resolves its DOM-free entry, which is the
// behavior worker-realm builds alias to. Keep the local owner byte-for-byte in
// step with that entry.
async function main() {
  for (const name of Object.keys(characterEntities)) {
    assert.strictEqual(
      decodeNamedCharacterReference(name),
      upstreamDefaultEntry(name),
      `named character reference parity failed for ${name}`,
    );
  }

  for (const value of ["", "&", "ampx", "notit", "semi", "#39", "#x27", "AMP", "zzzzz", "not-a-reference"]) {
    assert.strictEqual(
      decodeNamedCharacterReference(value),
      upstreamDefaultEntry(value),
      `named character reference parity failed for ${JSON.stringify(value)}`,
    );
  }

  assert.strictEqual(decodeNamedCharacterReference("amp"), "&");
  assert.strictEqual(decodeNamedCharacterReference("not"), "\u00AC", "entities without a closing semicolon decode");
  assert.strictEqual(decodeNamedCharacterReference("notit"), false, "partial matches must not decode");
  assert.strictEqual(decodeNamedCharacterReference("zzzzz"), false, "unknown names must not decode");
}

await main();
console.log("entities-named-character-reference test passed");
