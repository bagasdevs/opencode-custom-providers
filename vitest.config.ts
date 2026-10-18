import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // enrich.ts is types only, so v8 reports 0/0 for it and it counts as uncovered.
      exclude: ["src/enrich.ts"],
      reporter: ["text", "text-summary"],
      // Floor sits a bit under the 1.0.3 baseline (64.2 stmts / 60.7 branches /
      // 70 funcs / 65.4 lines) so a real regression fails while a refactor has room.
      thresholds: {
        statements: 62,
        branches: 58,
        functions: 68,
        lines: 63,
      },
    },
  },
})
