/*
 * A small XLSX writer for the report exports: worksheets of strings, numbers
 * and numbers with a number format (dates, percents), column widths, packed in
 * a zip of stored (uncompressed) entries. Enough for the reference app's
 * report workbook (SheetJS `json_to_sheet` output: a header row, then values).
 */

/** A cell: text, a number, a number with a format code ("0.00",
 *  "yyyy-mm-dd"), or nothing. */
export type XlsxCell = string | number | { v: number; z: string } | null | undefined;

export type XlsxSheet = {
  name: string;
  rows: XlsxCell[][];
  /** Column widths in characters (SheetJS `wch`). */
  widths?: number[];
};

// ── zip ──────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive of stored entries (no compression). */
export function zipStored(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  // 01/01/2026 00:00 in DOS date / time.
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    parts.push(local, f.data);
    central.push(cd);
    offset += local.length + f.data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ── workbook ────────────────────────────────────────────────────────────────

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

/** "A", "B", ... "Z", "AA"... */
export function columnName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Built-in number formats (ECMA-376 §18.8.30) used here. */
const BUILTIN: Record<string, number> = { "0.00": 2 };

/** The sheet XML; `styleOf` maps a format code to its cellXfs index. */
export function sheetXml(sheet: XlsxSheet, styleOf: (z: string) => number): string {
  const rows: string[] = [];
  sheet.rows.forEach((row, r) => {
    const cells: string[] = [];
    row.forEach((cell, c) => {
      if (cell === null || cell === undefined || cell === "") return;
      const ref = `${columnName(c)}${r + 1}`;
      if (typeof cell === "string") cells.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(cell)}</t></is></c>`);
      else if (typeof cell === "number") {
        if (Number.isFinite(cell)) cells.push(`<c r="${ref}"><v>${cell}</v></c>`);
      } else if (Number.isFinite(cell.v)) cells.push(`<c r="${ref}" s="${styleOf(cell.z)}"><v>${cell.v}</v></c>`);
    });
    rows.push(`<row r="${r + 1}">${cells.join("")}</row>`);
  });
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `${cols}<sheetData>${rows.join("")}</sheetData></worksheet>`
  );
}

/** An .xlsx file of `sheets`. */
export function buildXlsx(sheets: XlsxSheet[]): Uint8Array {
  // Number formats in use -> cellXfs (index 0 = General).
  const formats: string[] = [];
  for (const s of sheets)
    for (const row of s.rows)
      for (const c of row) if (c && typeof c === "object" && !formats.includes(c.z)) formats.push(c.z);
  const custom = formats.filter((z) => BUILTIN[z] === undefined);
  const fmtId = (z: string) => BUILTIN[z] ?? 164 + custom.indexOf(z);
  const styleOf = (z: string) => 1 + formats.indexOf(z);

  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const xml = (s: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`;
  const styles = xml(
    `<styleSheet xmlns="${ns}">` +
      (custom.length ? `<numFmts count="${custom.length}">${custom.map((z) => `<numFmt numFmtId="${fmtId(z)}" formatCode="${esc(z)}"/>`).join("")}</numFmts>` : "") +
      `<fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>` +
      `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="${1 + formats.length}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
      formats.map((z) => `<xf numFmtId="${fmtId(z)}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`).join("") +
      `</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  );
  const workbook = xml(
    `<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets>` +
      sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
      `</sheets></workbook>`,
  );
  const workbookRels = xml(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
      `<Relationship Id="rId${sheets.length + 1}" Type="${rel}/styles" Target="styles.xml"/></Relationships>`,
  );
  const contentTypes = xml(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
  );
  const rootRels = xml(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  const enc = new TextEncoder();
  return zipStored([
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rootRels) },
    { name: "xl/workbook.xml", data: enc.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(workbookRels) },
    { name: "xl/styles.xml", data: enc.encode(styles) },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(s, styleOf)) })),
  ]);
}
