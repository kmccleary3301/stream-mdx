import type { NodePresentation, NodePresentations, PresentationProps } from "../types";

const PRESENTATION_KEY_PATTERNS = [
  /^[a-z][a-z0-9-]*$/,
  /^inline:[a-z][a-z0-9-]*$/,
  /^html:[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?$/,
  /^component:[A-Za-z][A-Za-z0-9_.-]*$/,
  /^extension:[A-Za-z][A-Za-z0-9_.-]*$/,
] as const;
const RESERVED_PRESENTATION_PROPS: Record<string, true> = {
  className: true,
  style: true,
  title: true,
};

export function resolveNodePresentation<K extends keyof NodePresentations & string>(
  presentations: NodePresentations | undefined,
  key: K,
): NodePresentations[K] | undefined {
  if (!isNodePresentationKey(key)) {
    throw new TypeError(`invalid node presentation key: ${key}`);
  }
  if (!presentations || !Object.prototype.hasOwnProperty.call(presentations, key)) return undefined;
  const candidate = (presentations as unknown as Record<string, unknown>)[key];
  validateNodePresentation(key, candidate);
  return candidate as NodePresentations[K];
}
export function mergeNodePresentationProps(
  nativeProps: Readonly<Record<string, unknown>>,
  decoration: PresentationProps | undefined,
): Record<string, unknown> {
  if (!decoration) return nativeProps as Record<string, unknown>;
  const merged: Record<string, unknown> = {};
  for (const [property, value] of Object.entries(decoration)) {
    if (property === "className") {
      const nativeClass = nativeProps.className;
      merged.className = typeof nativeClass === "string" && value
        ? `${nativeClass} ${value}`
        : value ?? nativeClass;
    } else if (property === "style") {
      merged.style = { ...(nativeProps.style as object | undefined), ...(value as object) };
    } else if (!Object.prototype.hasOwnProperty.call(nativeProps, property)) {
      merged[property] = value;
    }
  }
  return merged;
}

export function validateNodePresentations(presentations: NodePresentations | undefined): void {
  if (presentations === undefined) return;
  if (presentations === null || typeof presentations !== "object" || Array.isArray(presentations)) {
    throw new TypeError("node presentations must be an object");
  }
  for (const key of Object.keys(presentations)) {
    if (!isNodePresentationKey(key)) {
      throw new TypeError(`invalid node presentation key: ${key}`);
    }
    validateNodePresentation(key, (presentations as Record<string, unknown>)[key]);
  }
}

export function isNodePresentationKey(key: string): boolean {
  return PRESENTATION_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function validateNodePresentation(key: string, candidate: unknown): asserts candidate is NodePresentation {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`node presentation for ${key} must be an object`);
  }
  const presentation = candidate as Record<string, unknown>;
  if (presentation.wrapper !== undefined && presentation.view !== undefined) {
    throw new TypeError(`node presentation for ${key}: wrapper and view are mutually exclusive`);
  }
  if (presentation.wrapper !== undefined && !isComponentType(presentation.wrapper)) {
    throw new TypeError(`node presentation for ${key} has an invalid wrapper`);
  }
  if (presentation.view !== undefined && !isComponentType(presentation.view)) {
    throw new TypeError(`node presentation for ${key} has an invalid view`);
  }
  if (presentation.props !== undefined) validatePresentationProps(key, presentation.props);
  if (presentation.slots !== undefined) validatePresentationSlots(key, presentation.slots);
  for (const property of Object.keys(presentation)) {
    if (property !== "props" && property !== "wrapper" && property !== "view" && property !== "slots") {
      throw new TypeError(`node presentation for ${key} has an unknown field: ${property}`);
    }
  }
}

function isComponentType(value: unknown): boolean {
  return typeof value === "function" || (typeof value === "object" && value !== null);
}

function validatePresentationProps(key: string, candidate: unknown): asserts candidate is PresentationProps {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`node presentation props for ${key} must be an object`);
  }
  const props = candidate as Record<string, unknown>;
  for (const [property, value] of Object.entries(props)) {
    const isDataOrAria = /^(data|aria)-[a-z][a-z0-9_.:-]*$/.test(property);
    if (RESERVED_PRESENTATION_PROPS[property] !== true && !isDataOrAria) {
      throw new TypeError(`presentation prop is not allowed: ${property}`);
    }
    if (property === "style" && (value === null || typeof value !== "object" || Array.isArray(value))) {
      throw new TypeError(`presentation style for ${key} must be an object`);
    }
  }
}

function validatePresentationSlots(key: string, candidate: unknown): void {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`node presentation slots for ${key} must be an object`);
  }
  for (const slot of Object.keys(candidate)) {
    if ((key !== "code" && key !== "table") || slot !== "actions") {
      throw new TypeError(`presentation slot is not supported for ${key}: ${slot}`);
    }
  }
}
