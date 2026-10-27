import { decodeHTML5Strict } from "entities";

export type ProtocolPolicyUrlTransform = (
  url: string,
  attribute: "href" | "src",
  context: { source: "markdown" | "html" },
) => string | null | undefined;

const DATA_IMAGE_PATTERN = /^data:image\/(?:png|gif|jpeg|webp|avif)(?:;[^,]*)?,/i;

export function createProtocolPolicyUrlTransform(
  protocols?: { readonly href?: readonly string[]; readonly src?: readonly string[] },
  transform?: ProtocolPolicyUrlTransform,
): ProtocolPolicyUrlTransform {
  const allowed = {
    href: new Set((protocols?.href ?? ["http", "https", "mailto", "tel", "callto"]).map((protocol) => protocol.toLowerCase())),
    src: new Set((protocols?.src ?? ["http", "https", "data"]).map((protocol) => protocol.toLowerCase())),
  };
  return (url, attribute, context) => {
    const candidate = transform ? transform(url, attribute, context) : url;
    if (candidate == null || candidate === "") return null;
    const decoded = candidate.includes("&") ? decodeHTML5Strict(candidate) : candidate;
    const normalized = decoded.replace(/[\x00-\x20\x7f]/g, "").toLowerCase();
    if (normalized.startsWith("javascript:") || normalized.startsWith("vbscript:")) return null;
    const protocol = /^([a-z][a-z0-9+.-]*):/.exec(normalized)?.[1];
    if (!protocol) return candidate;
    if (!allowed[attribute].has(protocol)) return null;
    if (protocol === "data" && (attribute !== "src" || !DATA_IMAGE_PATTERN.test(normalized))) return null;
    return candidate;
  };
}
