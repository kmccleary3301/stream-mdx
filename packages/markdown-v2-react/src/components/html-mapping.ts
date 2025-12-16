import type { HtmlElements } from "../types";
import type { ComponentRegistry } from "./index";

/** MDX-like components map for HTML tags */
export type HtmlComponentsLike = HtmlElements;

/**
 * Apply an MDX-like HTML components map to the ComponentRegistry.
 * Only provided tags are overridden; others fall back to defaults.
 */
export function applyHtmlComponents(registry: ComponentRegistry, components: HtmlComponentsLike): void {
  registry.setHtmlElements(components);
}
