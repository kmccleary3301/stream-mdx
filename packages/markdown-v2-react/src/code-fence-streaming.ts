// Boundary-local policy: public fence extraction preserves all content. This
// provisional-only helper is duplicated in core/worker to keep package APIs unchanged.
// Callers pass normalized LF source only while the owning block is not finalized.
export function trimProvisionalFenceTail(raw: string): string {
  if (raw.endsWith("\n")) return raw;
  const opening = raw.match(/^ {0,3}(`{3,}|~{3,})[^\n]*\n/);
  if (!opening) return raw;
  const lastNewline = raw.lastIndexOf("\n");
  const tail = raw.slice(lastNewline + 1).match(/^ {0,3}(`+|~+)[\t ]*$/);
  return tail && tail[1][0] === opening[1][0] && tail[1].length < opening[1].length ? raw.slice(0, lastNewline) : raw;
}
