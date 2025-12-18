import assert from "node:assert";

import { MermaidBlock } from "../src";

assert.strictEqual(typeof MermaidBlock, "function", "MermaidBlock should be a React component");
console.log("@stream-mdx/mermaid export test passed");

