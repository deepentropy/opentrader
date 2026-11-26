/** Title-case a SCREAMING or lower-case label (the reference sector/industry come through upper-cased, e.g.
 *  "ELECTRONIC COMPUTERS" → "Electronic Computers"). Small connectives stay lower-case; "&" and tokens with digits
 *  pass through. */
export function titleCase(s: string): string {
  const small = new Set(["and", "or", "the", "of", "for", "to", "in", "on", "a", "an"]);
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => {
      if (/\d/.test(w) || w === "&") return w;
      if (i > 0 && small.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}
