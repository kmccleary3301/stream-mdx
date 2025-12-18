import { readDocFile, renderMarkdownToHtml } from "../../lib/docs";

export default async function DocsIndexPage() {
  const markdown = await readDocFile("README.md");
  const html = await renderMarkdownToHtml(markdown);

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "96px 24px" }}>
      <article className="prose" dangerouslySetInnerHTML={{ __html: html }} />
    </main>
  );
}
