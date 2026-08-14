import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    setupFiles: [resolve(root, "tests/setup.ts")],
    server: {
      deps: {
        inline: ["@cloudflare/workers-oauth-provider"],
      },
    },
    alias: {
      "cloudflare:workers": resolve(root, "tests/cloudflare-workers-stub.ts"),
    },
  },
  resolve: {
    alias: {
      "cloudflare:workers": resolve(root, "tests/cloudflare-workers-stub.ts"),
    },
  },
});
