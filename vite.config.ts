import { defineConfig, searchForWorkspaceRoot } from "vite";
// @ts-expect-error node builtin (the project has no @types/node)
import { fileURLToPath } from "node:url";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Shared drawing core: the sibling repo deepentropy/lightweight-charts-drawing
// (its src/tv, and src/runtime for the chart bridge), read from source so
// edits there reload here without a build.
const drawingCore = fileURLToPath(new URL("../lightweight-charts-drawing/src/tv", import.meta.url));
const drawingRuntime = fileURLToPath(new URL("../lightweight-charts-drawing/src/runtime", import.meta.url));

export default defineConfig(async () => ({
  plugins: [
    solid(),
    tailwindcss(),
    // Vite watches only this project: also watch the drawing core so edits
    // there hot-reload here.
    { name: "watch-drawing-core", configureServer: (server: { watcher: { add: (p: string) => void } }) => { server.watcher.add(drawingCore); server.watcher.add(drawingRuntime); } },
  ],
  resolve: {
    alias: [
      { find: /^lightweight-charts-drawing\/tv/, replacement: drawingCore },
      { find: /^lightweight-charts-drawing\/runtime/, replacement: drawingRuntime },
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  clearScreen: false,
  server: {
    port: 1420,
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
    fs: {
      // @ts-expect-error process is a nodejs global
      allow: [searchForWorkspaceRoot(process.cwd()), drawingCore, drawingRuntime],
    },
  },
}));
