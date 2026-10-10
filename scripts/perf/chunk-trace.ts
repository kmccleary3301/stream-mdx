export function createChunkTrace(source: string, scenario: { updateIntervalMs: number; charRateCps: number; maxChunkChars: number }): Array<{ atMs: number; text: string }> {
  if (!Number.isFinite(scenario.charRateCps) || scenario.charRateCps <= 0) throw new Error("Invalid scenario character rate.");
  const interval = Math.max(1, scenario.updateIntervalMs);
  const ceiling = Math.max(1, Math.floor(scenario.maxChunkChars));
  const trace: Array<{ atMs: number; text: string }> = [];
  let offset = 0;
  let credit = 0;
  for (let tick = 1; offset < source.length; tick += 1) {
    credit += scenario.charRateCps * interval / 1000;
    const size = Math.min(Math.floor(credit), ceiling, source.length - offset);
    if (size === 0) continue;
    trace.push({ atMs: tick * interval, text: source.slice(offset, offset + size) });
    offset += size;
    credit -= size;
  }
  return trace;
}

export async function semanticSha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
