import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const migrations = await readD1Migrations(
  fileURLToPath(new URL("./migrations", import.meta.url))
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          WEBHOOK_SECRET: "test-secret-only",
          TELEGRAM_BOT_TOKEN: "test-token-only",
          OWNER_TELEGRAM_ID: "99999999",
          TEST_MIGRATIONS: migrations
        }
      }
    })
  ],
  test: {
    include: ["test/**/*.spec.js", "src/**/*.test.js"],
    setupFiles: ["./test/apply-migrations.js"]
  }
});
