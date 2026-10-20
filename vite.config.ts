import { defineConfig, searchForWorkspaceRoot } from "vite";
// @ts-expect-error node builtin (the project has no @types/node)
import { fileURLToPath } from "node:url";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import tauriConf from "./src-tauri/tauri.conf.json";

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
// Where the web dev server forwards /api (the server's default address).
// @ts-expect-error process is a nodejs global
const webServer = process.env.OPENTRADER_SERVER ?? "http://127.0.0.1:8787";

export default defineConfig(async ({ mode }: { mode: string }) => ({
  plugins: [
    solid(),
    tailwindcss(),
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
    { name: "watch-drawing-core", configureServer: (server: { watcher: { add: (p: string) => void } }) => { server.watcher.add(drawingCore); server.watcher.add(drawingRuntime); } },
  ],
  // ES module workers: a worker can load a module on demand (the backtest worker loads the indicator library only
  // for the Technical ratings strategy), as in dev where workers are modules already.
  worker: { format: "es" as const },
  // Entries first imported on demand (the OakScript worker runs a built-in's source with the helpers): bundled at
  // start so the dev server does not reload the page when one is first used.
  optimizeDeps: { include: ["lightweight-charts-indicators/helpers", "lightweight-charts-indicators/sources"] },
  resolve: {
    alias: [
      { find: /^lightweight-charts-drawing\/core/, replacement: drawingCore },
      { find: /^lightweight-charts-drawing\/runtime/, replacement: drawingRuntime },
      ...(mode === "web" ? webShims : []),
    ],
  },
  build: mode === "web" ? { outDir: "dist-web" } : undefined,

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  clearScreen: false,
  server: {
    port: mode === "web" ? 1430 : 1420,
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
      ignored: ["**/src-tauri/**"],
    },
    proxy: mode === "web" ? { "/api": { target: webServer, ws: true } } : undefined,
    fs: {
      // @ts-expect-error process is a nodejs global
      allow: [searchForWorkspaceRoot(process.cwd()), drawingCore, drawingRuntime],
    },
  },
}));
