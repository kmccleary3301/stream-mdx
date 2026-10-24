import {
  isRestrictedComponentName,
  parseRestrictedTag,
  type ContainerExtensionSpec,
  type RestrictedComponentDescriptor,
  type SyntaxExtensionDescriptor,
} from "@stream-mdx/core";

const CONTAINER_NAME = /^[A-Za-z0-9_-]+$/;

export interface RegisteredContainerOpening {
  readonly name: string;
  readonly component: string;
  readonly fenceLength: number;
  readonly props: Readonly<Record<string, unknown>>;
}

export function validateSyntaxExtensionDescriptor(
  syntax: SyntaxExtensionDescriptor | undefined,
  contentComponents: ReadonlyMap<string, RestrictedComponentDescriptor>,
): readonly ContainerExtensionSpec[] {
  if (syntax === undefined) return [];
  if (!syntax || typeof syntax !== "object" || syntax.contractVersion !== 1) {
    throw new Error("Unsupported syntax extension contract version");
  }
  if (syntax.containers !== undefined && !Array.isArray(syntax.containers)) {
    throw new Error("Syntax extension containers must be an array");
  }
  if (syntax.inline !== undefined && !Array.isArray(syntax.inline)) {
    throw new Error("Syntax extension inline rules must be an array");
  }

  const names = new Set<string>();
  for (const container of syntax.containers ?? []) {
    if (!container || typeof container !== "object" || !CONTAINER_NAME.test(container.name)) {
      throw new Error("Invalid syntax extension container name");
    }
    if (names.has(container.name)) {
      throw new Error(`Duplicate syntax extension container: ${container.name}`);
    }
    names.add(container.name);
    if (!isRestrictedComponentName(container.component) || !contentComponents.has(container.component)) {
      throw new Error(`Syntax extension container ${container.name} references an unregistered component`);
    }
  }
  return syntax.containers ?? [];
}

export function matchRegisteredContainerOpening(
  line: string,
  extensions: readonly ContainerExtensionSpec[],
  contentComponents: ReadonlyMap<string, RestrictedComponentDescriptor>,
  atBlockStart: boolean,
  hasLineTerminator: boolean,
): RegisteredContainerOpening | null {
  if (!atBlockStart || !hasLineTerminator) return null;
  const match = /^( {0,3})(:{3,})([A-Za-z0-9_-]+)(.*)$/.exec(line);
  const name = match?.[3];
  if (!match || !name) return null;
  const extension = extensions.find((candidate) => candidate.name === name);
  if (!extension || !contentComponents.has(extension.component)) return null;

  const propsSource = match[4]?.trim() ?? "";
  let attributes = "";
  if (propsSource) {
    if (!propsSource.startsWith("{") || !propsSource.endsWith("}")) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(propsSource);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      attributes += ` ${key}={${JSON.stringify(value)}}`;
    }
  }

  const parsedTag = parseRestrictedTag(`<${extension.component}${attributes}>`);
  if (!parsedTag.ok || parsedTag.kind !== "open") return null;
  return {
    name,
    component: extension.component,
    fenceLength: match[2].length,
    props: parsedTag.props,
  };
}

export function matchRegisteredContainerCloser(line: string, fenceLength: number): boolean {
  const match = /^ {0,3}(:{3,})[ \t]*$/.exec(line);
  return match?.[1]?.length === fenceLength;
}
