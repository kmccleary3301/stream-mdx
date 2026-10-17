import { createElement } from "react";
import type { JSXElementConstructor, Key, ReactElement, ReactNode } from "react";
import type { RestrictedComponentDescriptor } from "@stream-mdx/core";
import { deepFreeze, isRestrictedComponentName } from "@stream-mdx/core";

export type ContentComponentProps = Readonly<Record<string, unknown>>;

export interface ContentComponentHostProps {
  readonly key?: Key;
  readonly children?: ReactNode;
  readonly "data-diagnostic"?: string;
  readonly "data-component-status"?: string;
}

export interface ContentComponentRenderInput {
  readonly props: ContentComponentProps;
  readonly key: Key;
  readonly hasChildren: boolean;
  readonly renderChildren: () => ReactNode;
  readonly status: "open" | "closed" | "incomplete";
  readonly diagnostic?: string | undefined;
}

export type ContentComponentRenderResult =
  | { readonly kind: "invalid" }
  | { readonly kind: "suppressed" }
  | { readonly kind: "rendered"; readonly element: ReactElement };

export type ContentComponentRenderAdapter = (
  input: ContentComponentRenderInput,
) => ContentComponentRenderResult;

export interface ContentComponentRegistration {
  readonly render: ContentComponentRenderAdapter;
  readonly renderWhen: "open" | "closed";
}

export type ContentComponentsMap = Readonly<
  Record<string, ContentComponentRegistration>
>;

export type ContentComponentPropsGuard<P extends object> = (
  props: ContentComponentProps,
) => props is ContentComponentProps & P;

export interface ValidatedContentComponentOptions<P extends object> {
  readonly component: JSXElementConstructor<P & ContentComponentHostProps>;
  readonly validateProps: ContentComponentPropsGuard<P>;
  readonly renderWhen?: "open" | "closed";
}

export interface BroadContentComponentOptions {
  readonly component: JSXElementConstructor<ContentComponentProps & ContentComponentHostProps>;
  readonly validateProps?: undefined;
  readonly renderWhen?: "open" | "closed";
}

function createComponentElement<P extends object>(
  component: JSXElementConstructor<P & ContentComponentHostProps>,
  props: ContentComponentProps & P,
  input: ContentComponentRenderInput,
): ReactElement {
  const elementProps = input.diagnostic
    ? {
        ...props,
        key: input.key,
        children: undefined,
        "data-diagnostic": input.diagnostic,
        "data-component-status": input.status,
      }
    : {
        ...props,
        key: input.key,
        children: undefined,
        "data-component-status": input.status,
      };
  const element = input.hasChildren
    ? createElement(component, elementProps, input.renderChildren())
    : createElement(component, elementProps);
  // React creates its own props envelope; freeze that copy in production too.
  Object.freeze(element.props);
  return element;
}

function createValidatedRenderAdapter<P extends object>(
  component: JSXElementConstructor<P & ContentComponentHostProps>,
  validateProps: ContentComponentPropsGuard<P>,
  renderWhen: "open" | "closed",
): ContentComponentRenderAdapter {
  return (input) => {
    const frozenProps = deepFreeze({ ...input.props });
    if (!validateProps(frozenProps)) {
      return { kind: "invalid" };
    }
    if (renderWhen === "closed" && input.status === "open") {
      return { kind: "suppressed" };
    }

    return {
      kind: "rendered",
      element: createComponentElement(component, frozenProps, input),
    };
  };
}

function createBroadRenderAdapter(
  component: JSXElementConstructor<ContentComponentProps & ContentComponentHostProps>,
  renderWhen: "open" | "closed",
): ContentComponentRenderAdapter {
  return (input) => {
    const frozenProps = deepFreeze({ ...input.props });
    if (renderWhen === "closed" && input.status === "open") {
      return { kind: "suppressed" };
    }

    return {
      kind: "rendered",
      element: createComponentElement(component, frozenProps, input),
    };
  };
}

/**
 * Binds a typed host component to restricted source props. The returned adapter
 * retains the component type privately and exposes only the validated render seam.
 */
export function defineContentComponent<P extends object>(
  options: ValidatedContentComponentOptions<P>,
): ContentComponentRegistration;
export function defineContentComponent(
  options: BroadContentComponentOptions,
): ContentComponentRegistration;
export function defineContentComponent<P extends object>(
  options: ValidatedContentComponentOptions<P> | BroadContentComponentOptions,
): ContentComponentRegistration {
  const renderWhen = options.renderWhen ?? "open";
  if (options.validateProps) {
    return {
      render: createValidatedRenderAdapter(options.component, options.validateProps, renderWhen),
      renderWhen,
    };
  }

  return {
    render: createBroadRenderAdapter(options.component, renderWhen),
    renderWhen,
  };
}

/**
 * Normalizes user-supplied component registrations.
 * Rejects non-component names and malformed adapters.
 */
export function normalizeContentComponents(
  input?: Readonly<Record<string, ContentComponentRegistration>>,
): ContentComponentsMap {
  const result: Record<string, ContentComponentRegistration> = {};
  if (!input) return result;

  for (const [name, reg] of Object.entries(input)) {
    if (!name || !isRestrictedComponentName(name)) {
      continue;
    }
    if (typeof reg === "object" && reg !== null && typeof reg.render === "function") {
      result[name] = {
        render: reg.render,
        renderWhen: reg.renderWhen === "closed" ? "closed" : "open",
      };
    }
  }

  return result;
}

/**
 * Serializes host registrations to minimal descriptors for worker transmission.
 * Only serializable metadata crosses workers: name and renderWhen.
 */
export function toSerializableDescriptors(
  components: ContentComponentsMap,
): readonly RestrictedComponentDescriptor[] {
  const descriptors: RestrictedComponentDescriptor[] = [];
  for (const [name, reg] of Object.entries(components)) {
    descriptors.push({
      name,
      ...(reg.renderWhen ? { renderWhen: reg.renderWhen } : {}),
    });
  }
  return descriptors;
}
