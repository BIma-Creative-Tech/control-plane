import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` tidak butuh koneksi DB. Migrasi diterapkan oleh src/db/migrate.ts
// (drizzle-orm/node-postgres/migrator) di dalam container — lihat README.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
});
