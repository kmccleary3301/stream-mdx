export type StyleTarget = {
  id: string;
  selector: string;
  properties: string[];
  pseudo?: {
    before?: string[];
    after?: string[];
  };
};

const typographyProps = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "color",
  "margin-top",
  "margin-bottom",
];

const blockProps = [
  "display",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin-top",
  "margin-bottom",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "background-color",
  "box-shadow",
  "overflow",
  "overflow-x",
  "overflow-y",
];

const tableProps = ["border-collapse", "border-spacing", "table-layout", ...blockProps];

const tableCellProps = [
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "text-align",
  "vertical-align",
  "border-bottom-width",
  "border-bottom-color",
];

const listItemProps = [
  "margin-top",
  "margin-bottom",
  "padding-left",
  "position",
  "line-height",
];

const listMarkerProps = [
  "content",
  "position",
  "left",
  "right",
  "top",
  "width",
  "height",
  "margin-top",
  "padding-right",
  "font-size",
  "color",
  "opacity",
  "display",
];

const footnoteTextProps = ["color", "font-size", "line-height"];

export const STYLE_TARGETS: StyleTarget[] = [
  { id: "h1", selector: "#regression-root h1", properties: typographyProps },
  { id: "h2", selector: "#regression-root h2", properties: typographyProps },
  { id: "p", selector: "#regression-root p", properties: typographyProps },
  { id: "blockquote", selector: "#regression-root blockquote", properties: [...typographyProps, ...blockProps] },
  { id: "code-pre", selector: "#regression-root pre", properties: [...blockProps, "font-family", "font-size", "white-space"] },
  { id: "table", selector: "#regression-root table", properties: tableProps },
  { id: "table-th", selector: "#regression-root th", properties: tableCellProps },
  { id: "table-td", selector: "#regression-root td", properties: tableCellProps },
  { id: "list-ol", selector: "#regression-root ol", properties: blockProps },
  {
    id: "list-ol-li",
    selector: "#regression-root ol > li",
    properties: listItemProps,
    pseudo: { before: listMarkerProps },
  },
  {
    id: "list-ul-li",
    selector: "#regression-root ul > li",
    properties: listItemProps,
    pseudo: { before: listMarkerProps },
  },
  { id: "footnotes", selector: "#regression-root .footnotes", properties: [...blockProps, ...footnoteTextProps] },
  {
    id: "preview-pre-adjacent",
    selector: "#regression-root .markdown-mdx + pre",
    properties: ["margin-top", "border-top-left-radius", "border-top-right-radius", "border-top-width"],
  },
  { id: "mdx-block", selector: "#regression-root .markdown-mdx", properties: blockProps },
  { id: "math-inline", selector: "#regression-root .katex", properties: typographyProps },
  { id: "math-display", selector: "#regression-root .katex-display", properties: blockProps },
];
