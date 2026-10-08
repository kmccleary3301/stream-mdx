import { characterEntities } from "character-entities";

// To do: next major: use `Object.hasOwn`. Mirrors the upstream universal
// implementation in `decode-named-character-reference/index.js`.
const own = {}.hasOwnProperty;

/**
 * DOM-free decoder for named character references (`&amp;` -> `"&"`).
 *
 * This module is the worker-realm owner for `decode-named-character-reference`.
 * Upstream ships two implementations and selects them by environment: the
 * `worker`, `workerd`, `deno`, `edge-light`, `react-native`, and `default`
 * conditions all use the map lookup below, while `browser` selects
 * `index.dom.js`, whose module scope calls `document.createElement` and
 * therefore throws `ReferenceError: document is not defined` inside a Worker.
 *
 * Bundlers that target browsers (esbuild `--platform=browser`, ...) pick the
 * browser condition even when the output is a worker script. Worker-realm
 * builds alias `decode-named-character-reference` to this module (see
 * `tsup.worker-realm.ts`) so bundled worker entries never resolve a DOM
 * implementation, matching what Node, SSR, and tests already execute.
 */
export function decodeNamedCharacterReference(value: string): string | false {
  return own.call(characterEntities, value) ? characterEntities[value] : false;
}
