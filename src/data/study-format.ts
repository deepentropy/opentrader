/*
 * Values of a study written in its own format (indicators library `format`,
 * the reference metaInfo format): a price with a fixed number of decimals, a
 * volume abbreviated with K / M / B / T ("5.37 K"), a percentage ("12.50%").
 * Alert amounts (the dialog's value fields, the messages) use it; the text is
 * read back with its suffix.
 */
export type StudyFormat = { type: "price" | "volume" | "percent"; precision?: number };

/** Narrow no-break space between a volume and its unit, as the reference writes it. */
const UNIT_SPACE = " ";
const UNITS: [number, string][] = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

const groupThousands = (s: string): string => {
  const [int, dec] = s.split(".");
  const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return dec !== undefined ? `${g}.${dec}` : g;
};

/** A value in a study format. */
export function formatStudyValue(v: number, f: StudyFormat): string {
  if (f.type === "volume") {
    const a = Math.abs(v);
    for (const [size, unit] of UNITS) if (a >= size) return `${(v / size).toFixed(2)}${UNIT_SPACE}${unit}`;
    return String(Math.round(v));
  }
  const text = groupThousands(v.toFixed(f.precision ?? 2));
  return f.type === "percent" ? `${text}%` : text;
}

/** The number an amount text stands for ("5.37 K", "1,234.50", "−2.5", "12%"); NaN when it is not one. */
export function parseAmountText(text: string): number {
  const t = text.replace(/[,\s  ]/g, "").replace(/−/g, "-").replace(/%$/, "");
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+))([KMBT])?$/i.exec(t);
  if (!m) return NaN;
  const unit = m[2]?.toUpperCase();
  const size = unit ? UNITS.find(([, u]) => u === unit)![0] : 1;
  return parseFloat(m[1]) * size;
}

/** One step up / down of an amount text in its last decimal, its unit kept ("5.37 K" → "5.38 K"). */
export function stepAmountText(text: string, dir: 1 | -1): string {
  const t = text.trim();
  const m = /^(.*?)([\s ]*[KMBT%])?$/i.exec(t);
  const num = (m?.[1] ?? t).replace(/,/g, "").replace(/−/g, "-");
  const suffix = m?.[2] ?? "";
  const v = parseFloat(num);
  const decimals = num.includes(".") ? num.split(".")[1].length : 2;
  return ((Number.isFinite(v) ? v : 0) + dir / 10 ** decimals).toFixed(decimals) + suffix;
}
