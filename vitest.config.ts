import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    setupFiles: ["dotenv/config"],
    // DB-backed tests share one database; run files sequentially to keep
    // fixtures from racing each other. Tests inside a file may still be
    // concurrent when they say so.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
