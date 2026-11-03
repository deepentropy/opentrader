import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  resolve: { alias: { "cloudflare:workers": fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url)) } },
});
