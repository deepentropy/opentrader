import { defineConfig, searchForWorkspaceRoot } from "vite";
// @ts-expect-error node builtin (the project has no @types/node)
import { fileURLToPath } from "node:url";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import tauriConf from "./src-tauri/tauri.conf.json";
// @ts-expect-error plain JavaScript plugin (scripts/)
import { indicatorManifest } from "./scripts/indicator-manifest-plugin.mjs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Shared drawing core: the sibling repo deepentropy/lightweight-charts-drawing
// (its src/core, and src/runtime for the chart bridge), read from source so
// edits there reload here without a build.
const drawingCore = fileURLToPath(new URL("../lightweight-charts-drawing/src/core", import.meta.url));
const drawingRuntime = fileURLToPath(new URL("../lightweight-charts-drawing/src/runtime", import.meta.url));

// Web build (`--mode web`): the desktop bridge modules are replaced by src/web,
// which talks to the OpenTrader server (src-tauri/crates/server) instead.
const webShims = [
  { find: /^@tauri-apps\/api\/core$/, replacement: fileURLToPath(new URL("./src/web/tauri-core.ts", import.meta.url)) },
  { find: /^@tauri-apps\/api\/event$/, replacement: fileURLToPath(new URL("./src/web/tauri-event.ts", import.meta.url)) },
  { find: /^@tauri-apps\/plugin-opener$/, replacement: fileURLToPath(new URL("./src/web/tauri-opener.ts", import.meta.url)) },
];
// Community website (`--mode community`, src/community-site): the Community
// panel alone, full width, served by deploy/community. No desktop bridge and
// no app server: the bindings, the dialogs and the opener are stand-ins.
const communityShims = [
  { find: /^(\.\.?\/)+bindings$/, replacement: fileURLToPath(new URL("./src/community-site/shims/bindings.ts", import.meta.url)) },
  { find: /^(\.\.?\/)+components\/Dialogs$/, replacement: fileURLToPath(new URL("./src/community-site/shims/dialogs.ts", import.meta.url)) },
  { find: /^@tauri-apps\/plugin-opener$/, replacement: fileURLToPath(new URL("./src/web/tauri-opener.ts", import.meta.url)) },
];
const COMMUNITY = (mode: string) => mode === "community";

// Where the web dev server forwards /api (the server's default address).
// @ts-expect-error process is a nodejs global
const webServer = process.env.OPENTRADER_SERVER ?? "http://127.0.0.1:8787";

const DEMO_URL = "https://demo.opentrader.markets/";
const DEMO_TITLE = "OpenTrader online demo: free stock charts in your browser";
const DEMO_DESCRIPTION =
  "Free stock charts in your browser: 1,000+ indicators, drawing tools, a stock screener, alerts and backtesting. No sign-up. Also a free desktop app.";
const webSeo = () => ({
  name: "web-seo",
  transformIndexHtml: (html: string) =>
    html.replace(
      "<title>OpenTrader</title>",
      [
        `<title>${DEMO_TITLE}</title>`,
        `<meta name="description" content="${DEMO_DESCRIPTION}" />`,
        `<link rel="canonical" href="${DEMO_URL}" />`,
        `<meta property="og:site_name" content="OpenTrader" />`,
        `<meta property="og:title" content="${DEMO_TITLE}" />`,
        `<meta property="og:description" content="${DEMO_DESCRIPTION}" />`,
        `<meta property="og:url" content="${DEMO_URL}" />`,
        `<meta property="og:image" content="https://opentrader.markets/assets/screenshot.png" />`,
        `<meta property="og:type" content="website" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
      ].join("\n    "),
    ),
  generateBundle(this: { emitFile: (f: { type: "asset"; fileName: string; source: string }) => void }) {
    this.emitFile({
      type: "asset",
      fileName: "robots.txt",
      source: "User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /ingest/\n",
    });
  },
});

export default defineConfig(async ({ mode }: { mode: string }) => ({
  ...(COMMUNITY(mode)
    ? {
        root: fileURLToPath(new URL("./src/community-site", import.meta.url)),
        publicDir: fileURLToPath(new URL("./public", import.meta.url)),
      }
    : {}),
  plugins: [
    solid(),
    tailwindcss(),
    // The indicator names, read from the library at build time (the library itself loads on first use).
    indicatorManifest(),
    // Vite watches only this project: also watch the drawing core so edits
    // there hot-reload here.
    // The splash in index.html shows the app version (the installer's, from
    // tauri.conf.json).
    { name: "app-version", transformIndexHtml: (html: string) => html.replace("__APP_VERSION__", tauriConf.version) },
    // Web version: the splash says the app also exists for the desktop.
    {
      name: "web-desktop-app",
      transformIndexHtml: (html: string) =>
        html.replace("<!--web-desktop-app-->", mode === "web" ? '<div class="splash-web">Also available as a free desktop app.</div>' : ""),
    },
    // Web version: what search engines and link previews show for the demo, and a robots.txt that keeps
    // crawlers off the API (the single-page fallback would otherwise answer it with the app).
    ...(mode === "web" ? [webSeo()] : []),
    { name: "watch-drawing-core", configureServer: (server: { watcher: { add: (p: string) => void } }) => { server.watcher.add(drawingCore); server.watcher.add(drawingRuntime); } },
  ],
  // ES module workers: a worker can load a module on demand (the backtest worker loads the indicator library only
  // for the Technical ratings strategy), as in dev where workers are modules already.
  worker: { format: "es" as const },
  // Entries first imported on demand (the OakScript worker runs a built-in's source with the helpers): bundled at
  // start so the dev server does not reload the page when one is first used.
  // The build's scripts in ASCII (other characters as \u escapes): a script's text with a single character past Latin-1
  // is held two bytes per character, and the indicator library's chunk (~11 MB) is loaded in the window and in every
  // study worker (12/11/2026: 22,920 such characters in it). The dev server's copy keeps its comments, which have some.
  esbuild: { charset: "ascii" },
  optimizeDeps: { include: ["lightweight-charts-indicators/helpers", "lightweight-charts-indicators/sources", "lightweight-charts-indicators/loader"] },
  resolve: {
    alias: [
      { find: /^lightweight-charts-drawing\/core/, replacement: drawingCore },
      { find: /^lightweight-charts-drawing\/runtime/, replacement: drawingRuntime },
      ...(mode === "web" ? webShims : []),
      ...(COMMUNITY(mode) ? communityShims : []),
    ],
  },
  // No gzip sizes in the build report: computing them for the indicator library's chunks (~20 MB each, in the window
  // and in the study worker) took the build past the release workflow's 4 GB heap (#258).
  build: {
    reportCompressedSize: false,
    ...(mode === "web"
      ? { outDir: "dist-web" }
      : COMMUNITY(mode)
        ? { outDir: fileURLToPath(new URL("./deploy/community/site", import.meta.url)), emptyOutDir: true }
        : {}),
  },
  // The version, for the usage statistics (data/analytics.ts).
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(tauriConf.version),
    // The website calls its own server (same address), unless pointed elsewhere for a local run.
    // @ts-expect-error process is a nodejs global
    ...(COMMUNITY(mode) ? { "import.meta.env.VITE_COMMUNITY_URL": JSON.stringify(process.env.VITE_COMMUNITY_URL ?? "") } : {}),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  clearScreen: false,
  server: {
    port: mode === "web" ? 1430 : COMMUNITY(mode) ? 1450 : 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Research files, dev builds (a cargo target can sit in .tmp) and agent worktrees (whose node_modules link to
      // this one) are not the app: watching them makes the dev server crawl.
      ignored: ["**/src-tauri/**", "**/.tmp/**", "**/.claude/**"],
    },
    proxy: mode === "web" ? { "/api": { target: webServer, ws: true } } : undefined,
    fs: {
      // @ts-expect-error process is a nodejs global
      allow: [searchForWorkspaceRoot(process.cwd()), drawingCore, drawingRuntime],
    },
  },
}));
