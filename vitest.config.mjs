import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          WEBHOOK_SECRET: "test-secret-only",
          TELEGRAM_BOT_TOKEN: "test-token-only",
          OWNER_TELEGRAM_ID: "99999999"
        }
      }
    })
  ],
  test: {
    include: ["test/**/*.spec.js"]
  }
});
