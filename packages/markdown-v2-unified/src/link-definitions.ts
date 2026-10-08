/**
 * Extracts CommonMark link reference definitions from markdown text.
 * Format: [label]: destination "title"
 */
export function extractLinkDefinitions(markdown: string): string {
  if (!markdown) return "";
  const lines = markdown.split(/\r?\n/);
  const defs: string[] = [];
  const refStartRegex = /^[ ]{0,3}\[[^\]]+\]:\s*\S+/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (refStartRegex.test(line)) {
      defs.push(line);
      let j = i + 1;
      while (j < lines.length && /^(?:[ ]{4,}|\t)/.test(lines[j])) {
        defs.push(lines[j]);
        j++;
      }
      i = j - 1;
    }
  }

  return defs.join("\n");
}
