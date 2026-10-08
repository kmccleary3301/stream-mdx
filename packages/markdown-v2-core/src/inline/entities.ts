/**
 * Self-contained HTML entity decoding for CommonMark compliance.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",
  copy: "\u00A9",
  reg: "\u00AE",
  trade: "\u2122",
  times: "\u00D7",
  divide: "\u00F7",
  cent: "\u00A2",
  pound: "\u00A3",
  yen: "\u00A5",
  euro: "\u20AC",
  sect: "\u00A7",
  deg: "\u00B0",
  plusmn: "\u00B1",
  para: "\u00B6",
  middot: "\u00B7",
  frac14: "\u00BC",
  frac12: "\u00BD",
  frac34: "\u00BE",
  laquo: "\u00AB",
  raquo: "\u00BB",
  hellip: "\u2026",
  prime: "\u2032",
  Prime: "\u2033",
  lsquo: "\u2018",
  rsquo: "\u2019",
  sbquo: "\u201A",
  ldquo: "\u201C",
  rdquo: "\u201D",
  bdquo: "\u201E",
  dagger: "\u2020",
  Dagger: "\u2021",
  bull: "\u2022",
  ndash: "\u2013",
  mdash: "\u2014",
  tilde: "\u02DC",
  asymp: "\u2248",
  ne: "\u2260",
  le: "\u2264",
  ge: "\u2265",
  infin: "\u221E",
  forall: "\u2200",
  part: "\u2202",
  exist: "\u2203",
  empty: "\u2205",
  nabla: "\u2207",
  isin: "\u2208",
  notin: "\u2209",
  ni: "\u220B",
  prod: "\u220F",
  sum: "\u2211",
  minus: "\u2212",
  radic: "\u221A",
  prop: "\u221D",
  ang: "\u2220",
  and: "\u2227",
  or: "\u2228",
  cap: "\u2229",
  cup: "\u222A",
  int: "\u222B",
  there4: "\u2234",
  sim: "\u223C",
  cong: "\u2245",
  sub: "\u2282",
  sup: "\u2283",
  nsub: "\u2284",
  sube: "\u2286",
  supe: "\u2287",
  oplus: "\u2295",
  otimes: "\u2297",
  perp: "\u22A5",
  sdot: "\u22C5",
  alpha: "\u03B1",
  beta: "\u03B2",
  gamma: "\u03B3",
  delta: "\u03B4",
  epsilon: "\u03B5",
  zeta: "\u03B6",
  eta: "\u03B7",
  theta: "\u03B8",
  iota: "\u03B9",
  kappa: "\u03BA",
  lambda: "\u03BB",
  mu: "\u03BC",
  nu: "\u03BD",
  xi: "\u03BE",
  omicron: "\u03BF",
  pi: "\u03C0",
  rho: "\u03C1",
  sigma: "\u03C3",
  tau: "\u03C4",
  upsilon: "\u03C5",
  phi: "\u03C6",
  chi: "\u03C7",
  psi: "\u03C8",
  omega: "\u03C9",
  check: "\u2713",
  cross: "\u2717",
};

export function decodeEntity(raw: string): string {
  if (!raw.startsWith("&") || !raw.endsWith(";")) {
    return raw;
  }
  const inner = raw.slice(1, -1);

  // Numeric decimal entity: &#1234;
  if (inner.startsWith("#")) {
    const isHex = inner[1] === "x" || inner[1] === "X";
    const numStr = isHex ? inner.slice(2) : inner.slice(1);
    const codePoint = isHex ? Number.parseInt(numStr, 16) : Number.parseInt(numStr, 10);
    if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
      return "\uFFFD";
    }
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return "\uFFFD";
    }
  }

  // Named entity: &name;
  const decoded = NAMED_ENTITIES[inner];
  if (decoded !== undefined) {
    return decoded;
  }

  return raw;
}
