// Fixes in the chart library's installed builds, applied after `npm install` / `npm ci` (postinstall).
//
// A price scale keeps one price-range snapshot for both gestures: dragging the chart (scroll) and dragging the price
// axis (scale). Ending an axis drag clears it even when no axis drag started, so a press and release on the price axis
// while the chart is being dragged (a second finger on a phone) leaves the chart drag without its snapshot: every later
// drag of the chart throws "Value is null". The fix: ending an axis drag that never started changes nothing.
//
// Each fix names the exact text it replaces; a library update that changes it stops the install, so the fix is looked
// at again instead of silently dropped.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../node_modules/lightweight-charts/dist/", import.meta.url));

export const FIXES = [
  {
    file: "lightweight-charts.production.mjs",
    from: "c_(){this.qe()||this.Oo()||(this.Co=null,this._o=null)}",
    to: "c_(){this.qe()||this.Oo()||null===this.Co||(this.Co=null,this._o=null)}",
  },
  {
    file: "lightweight-charts.development.mjs",
    from: `    _internal_endScale() {
        if (this._internal_isPercentage() || this._internal_isIndexedTo100()) {
            return;
        }
        this._private__scaleStartPoint = null;`,
    to: `    _internal_endScale() {
        if (this._internal_isPercentage() || this._internal_isIndexedTo100()) {
            return;
        }
        if (this._private__scaleStartPoint === null) {
            return;
        }
        this._private__scaleStartPoint = null;`,
  },
];

/** Applies the fixes; returns the files changed. Throws when a build has neither the old nor the fixed text. */
export function patchChartLibrary(dir = dist) {
  const changed = [];
  for (const { file, from, to } of FIXES) {
    const path = dir + file;
    const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    if (text.includes(to)) continue;
    if (text.split(from).length !== 2) throw new Error(`patch-chart-library: ${file} changed, check the fix by hand`);
    writeFileSync(path, text.replace(from, to));
    changed.push(file);
  }
  return changed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const changed = patchChartLibrary();
  if (changed.length) console.log(`patch-chart-library: ${changed.join(", ")}`);
}
