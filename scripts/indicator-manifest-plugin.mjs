// Vite plugin: `virtual:indicator-manifest`, the names of the indicator library's entries (id, name, short name,
// group) read from the installed library at build time. The app lists the indicators from it and loads the library
// itself on first use (src/window/chart/indicators/registry.ts), which keeps the library out of the first download.
//
// The names are read by a node process of their own: importing the library here kept its ~1,900 studies in the build's
// memory until the end of the build, which then ran out of memory at the release workflow's heap size (#258).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const ID = "virtual:indicator-manifest";
const RESOLVED = "\0" + ID;

const READ_NAMES = `
const GROUP = { standard: "s", community: "c", candlestick: "k" };
const { indicatorRegistry, version } = await import("lightweight-charts-indicators");
const entries = indicatorRegistry.map((e) => [e.id, e.name, e.shortName, GROUP[e.group]]);
process.stdout.write(JSON.stringify({ version, entries }));
`;

export function indicatorManifest() {
  return {
    name: "indicator-manifest",
    resolveId(id) {
      return id === ID ? RESOLVED : null;
    },
    async load(id) {
      if (id !== RESOLVED) return null;
      const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", READ_NAMES], {
        cwd: process.cwd(),
        maxBuffer: 64 * 1024 * 1024,
      });
      return `export default ${stdout};`;
    },
  };
}
