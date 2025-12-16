import type { TableElements } from "../types";
import type { ComponentRegistry } from "./index";

/** ShadCN-like components map for structured tables */
export type TableComponentsLike = Partial<TableElements>;

/**
 * Apply a structured table components map to the ComponentRegistry.
 * Only provided parts are overridden; others fall back to defaults.
 */
export function applyTableComponents(registry: ComponentRegistry, components: TableComponentsLike): void {
  registry.setTableElements(components);
}
