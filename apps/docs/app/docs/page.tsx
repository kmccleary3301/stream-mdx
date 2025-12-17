import { readDocFile, renderMarkdownToHtml } from "../../lib/docs";

export default async function DocsIndexPage() {
  const markdown = await readDocFile("README.md");
  const html = await renderMarkdownToHtml(markdown);

  return (
    <article className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
  );
}
