import assert from "node:assert";
import { DEFAULT_VIRTUALIZED_LIST_CONFIG, shouldVirtualizeList } from "../src/renderer/virtualized-list";

function runVirtualizedListConfigSuite(): void {
  const enabled = {
    ...DEFAULT_VIRTUALIZED_LIST_CONFIG,
    enabled: true,
    depthThreshold: 2,
    minItems: 60,
  };

  assert.strictEqual(shouldVirtualizeList(100, 3, enabled), true, "deep lists over the item threshold must virtualize");
  assert.strictEqual(shouldVirtualizeList(20, 3, enabled), false, "lists under the item threshold should render fully");
  assert.strictEqual(shouldVirtualizeList(100, 1, enabled), false, "shallow lists should avoid virtualization");

  const disabled = { ...enabled, enabled: false };
  assert.strictEqual(shouldVirtualizeList(200, 5, disabled), false, "disabled flag should always short-circuit");
}

runVirtualizedListConfigSuite();
console.log("Virtualized list config test passed");
