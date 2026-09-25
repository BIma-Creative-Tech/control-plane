import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Test integrasi: butuh TEST_DATABASE_URL (Postgres SEKALI PAKAI — skema public/pgboss di-DROP!).
// Tanpa variabel itu suite di-skip. Lihat README §Test integrasi.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
