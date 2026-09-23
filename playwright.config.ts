import { defineConfig } from "@playwright/test";

// E2E smoke. Target: PLAYWRIGHT_BASE_URL (mis. container control-plane di network lokal).
// Browser Playwright tidak di-install otomatis; test di-skip bila browser/URL tidak tersedia.
export default defineConfig({
  testDir: "./e2e",
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL,
    trace: "off",
  },
});
