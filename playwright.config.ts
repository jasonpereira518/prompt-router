import { defineConfig } from "@playwright/test";
import { scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://localhost:3017", trace: "retain-on-failure" },
  webServer: [
    {
      command: "node tests/mock-gateway.mjs",
      url: "http://127.0.0.1:20137/api/health",
      reuseExistingServer: false,
    },
    {
      command: "npm run dev -- --port 3017",
      url: "http://localhost:3017",
      reuseExistingServer: false,
      env: {
        APP_ORIGIN: "http://localhost:3017",
        OWNER_EMAIL: "owner@example.test",
        OWNER_PASSWORD_HASH: `test-salt:${scryptSync("test-password-only", "test-salt", 64).toString("hex")}`,
        OMNI_DATA_DIR: join(tmpdir(), "omni-e2e-data"),
        OMNI_GATEWAY_URL: "http://127.0.0.1:20137",
        OMNI_MANAGEMENT_KEY: "test-management-only",
      },
    },
  ],
});
