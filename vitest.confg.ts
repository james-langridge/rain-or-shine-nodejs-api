import { defineConfig } from "vitest/config";
import * as path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      exclude: [
        "node_modules/**",
        "dist/**",
        "**/*.d.ts",
        "**/*.config.*",
        "**/mockData/**",
        "**/types/**",
        "**/*.spec.ts",
        "**/*.test.ts",
      ],
      include: ["src/**/*.ts"],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{js,ts}"],
    exclude: ["node_modules", "dist"],
    // Mock modules that are causing issues
    alias: {
      "@/": path.resolve(__dirname, "./src/"),
    },
    // Timeout for async operations
    testTimeout: 10000,
    hookTimeout: 10000,
    // Reporter configuration
    reporters: ["verbose"],
    // Run tests in sequence for better debugging
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
