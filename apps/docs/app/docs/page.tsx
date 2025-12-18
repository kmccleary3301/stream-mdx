import { readDocFile, renderMarkdownToHtml } from "../../lib/docs";
import { TableOfContents } from "@/components/on-this-page";

export default async function DocsIndexPage() {
  const markdown = await readDocFile("README.md");
  const html = await renderMarkdownToHtml(markdown);

  return (
    <>
      <div
        id="article-content-wrapper"
        className="prose markdown flex flex-col space-y-3 text-theme-primary"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <TableOfContents />
    </>
  );
}
