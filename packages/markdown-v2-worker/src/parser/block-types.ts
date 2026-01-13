// Helpers for mapping Lezer node names to streaming markdown block types.
// Extracted from worker.ts so the logic can be shared and unit tested.

const BLOCK_NODE_TYPES = new Set([
  "Paragraph",
  "Blockquote",
  "FencedCode",
  "IndentedCode",
  "BulletList",
  "OrderedList",
  "HTMLBlock",
  "ThematicBreak",
  "HorizontalRule",
  "ATXHeading",
  "SetextHeading",
]);

function normalizeNodeName(nodeType: string): string {
  if (!nodeType) return "";
  if (nodeType.startsWith("ATXHeading")) {
    return "ATXHeading";
  }
  if (nodeType.startsWith("SetextHeading")) {
    return "SetextHeading";
  }
  return nodeType;
}

export function isBlockLevelNode(nodeType: string): boolean {
  const normalized = normalizeNodeName(nodeType);
  if (normalized === "BulletList" || normalized === "OrderedList") {
    return true;
  }
  return BLOCK_NODE_TYPES.has(normalized);
}

export function mapLezerNodeToBlockType(nodeType: string): string {
  const normalized = normalizeNodeName(nodeType);
  switch (normalized) {
    case "ATXHeading":
    case "SetextHeading":
      return "heading";
    case "Paragraph":
      return "paragraph";
    case "FencedCode":
    case "IndentedCode":
      return "code";
    case "Blockquote":
      return "blockquote";
    case "BulletList":
    case "OrderedList":
      return "list";
    case "HTMLBlock":
      return "html";
    case "ThematicBreak":
    case "HorizontalRule":
      return "hr";
    default:
      return "paragraph";
  }
}
