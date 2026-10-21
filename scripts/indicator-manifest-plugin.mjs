// Vite plugin: `virtual:indicator-manifest`, the names of the indicator library's entries (id, name, short name,
// group) read from the installed library at build time. The app lists the indicators from it and loads the library
// itself on first use (src/window/chart/indicators/registry.ts), which keeps the library out of the first download.
const ID = "virtual:indicator-manifest";
const RESOLVED = "\0" + ID;
const GROUP = { standard: "s", community: "c", candlestick: "k" };

export function indicatorManifest() {
  return {
    name: "indicator-manifest",
    resolveId(id) {
      return id === ID ? RESOLVED : null;
    },
    async load(id) {
      if (id !== RESOLVED) return null;
      const { indicatorRegistry, version } = await import("lightweight-charts-indicators");
      const entries = indicatorRegistry.map((e) => [e.id, e.name, e.shortName, GROUP[e.group]]);
      return `export default ${JSON.stringify({ version, entries })};`;
    },
  };
}
