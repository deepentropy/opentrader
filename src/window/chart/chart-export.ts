/*
 * "Download chart data" (the reference app's chart data export): every
 * mounted chart registers a source here; the dialog lists the charts of the
 * shown layout and saves the chosen one as "<symbol>, <interval>.csv".
 *
 * CSV columns (the reference export): time, the main series values (open,
 * high, low, close; close only for single-value chart types), then every
 * visible study plot by plot title, compared symbols as "<title>: <value>".
 * One row per loaded bar; a missing value is an empty cell. Time is UNIX
 * seconds, or ISO 8601 in the chart time zone (a date only for day, week and
 * month bars).
 */

/** One exported value column. */
export type ExportColumn = { title: string; values: Map<number, number> };

export type ChartExportSource = {
  /** "<symbol>, <interval>" (the dialog row and the file name). */
  title: () => string;
  /** The chart is in the shown layout. */
  shown: () => boolean;
  active: () => boolean;
  /** Chart element (layout order). */
  host: () => HTMLElement | undefined;
  /** Chart time zone (IANA) and whether bars are day / week / month. */
  timeZone: () => string;
  dwm: () => boolean;
  /** Bar times (ascending) and the value columns. */
  data: () => { times: number[]; columns: ExportColumn[] };
};

const sources = new Map<number, ChartExportSource>();

export function registerChartExport(id: number, source: ChartExportSource): () => void {
  sources.set(id, source);
  return () => {
    if (sources.get(id) === source) sources.delete(id);
  };
}

/** The charts of the shown layout, in layout order. */
export function exportableCharts(): { id: number; source: ChartExportSource }[] {
  return [...sources.entries()]
    .filter(([, s]) => s.shown() && s.host()?.isConnected)
    .sort(([, a], [, b]) => {
      const ha = a.host()!;
      const hb = b.host()!;
      return ha.compareDocumentPosition(hb) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    })
    .map(([id, source]) => ({ id, source }));
}

export type ExportTimeFormat = "iso" | "unix";

/** Offset (seconds) of `timeZone` at `sec`. */
function zoneOffset(timeZone: string, sec: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(sec * 1000));
  const v = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second")) / 1000;
  return wall - sec;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "UTC" for UNIX time, else the zone's current offset ("UTC-4", "UTC+5:30"). */
export function exportZoneLabel(format: ExportTimeFormat, timeZone: string): string {
  if (format === "unix") return "UTC";
  const off = zoneOffset(timeZone, Date.now() / 1000);
  if (off === 0) return "UTC";
  const a = Math.abs(off);
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  return `UTC${off < 0 ? "-" : "+"}${h}${m ? `:${pad(m)}` : ""}`;
}

function isoTime(sec: number, timeZone: string, dwm: boolean): string {
  const off = zoneOffset(timeZone, sec);
  const [stamp] = new Date((sec + off) * 1000).toISOString().split(".");
  if (dwm) return stamp.split("T")[0];
  if (off === 0) return `${stamp}Z`;
  const a = Math.abs(off);
  return `${stamp}${off < 0 ? "-" : "+"}${pad(Math.floor(a / 3600))}:${pad((a % 3600) / 60)}`;
}

/** CSV value escaping (quotes when needed). */
function csvCell(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildChartCsv(source: ChartExportSource, format: ExportTimeFormat): string {
  const { times, columns } = source.data();
  const tz = source.timeZone();
  const dwm = source.dwm();
  const lines = [["time", ...columns.map((c) => csvCell(c.title))].join(",")];
  for (const t of times) {
    const row = [format === "unix" ? String(t) : isoTime(t, tz, dwm)];
    for (const c of columns) {
      const v = c.values.get(t);
      row.push(v == null || Number.isNaN(v) ? "" : String(v));
    }
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

/** File name of the export ("NASDAQ:AAPL, 1D.csv" with the characters a
 *  file name cannot hold replaced). */
export function exportFileName(source: ChartExportSource): string {
  return `${source.title().replace(/[\\/:*?"<>|]/g, "_")}.csv`;
}
