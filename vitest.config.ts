import { defineConfig } from "vitest/config";

export default defineConfig({
  // The npm Obsidian package only ships types; DOM tests use a narrow host stub.
  resolve: { alias: { obsidian: new URL("./tests/helpers/obsidian.ts", import.meta.url).pathname } },
  test: {
    environment: "node",
    // Only the plugin's own suites; the default glob would also sweep cloned
    // research repos under .reference/.
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "extension/src/**/*.ts"],
      reportsDirectory: "coverage",
      reporter: ["text-summary", "json-summary", "html", "lcov"],
      reportOnFailure: true,
      // Floors of the measured 2026-10-14 baseline, with stronger checks on
      // persistence/authorization boundaries. Do not auto-lower these values.
      thresholds: {
        statements: 61, functions: 60, branches: 60, lines: 65,
        "src/web-bridge/server.ts": { statements: 86, functions: 78, branches: 80, lines: 97 },
        "src/surface-transactions.ts": { statements: 83, functions: 90, branches: 78, lines: 93 },
        "src/surface-transaction-journal.ts": { statements: 87, functions: 94, branches: 82, lines: 98 },
        "src/credential-session.ts": { statements: 94, functions: 96, branches: 88, lines: 98 },
        "src/tutor-task.ts": { statements: 85, functions: 86, branches: 87, lines: 92 },
        "src/desktop-state-io.ts": { statements: 87, functions: 78, branches: 77, lines: 94 },
        "src/document-edit-target.ts": { statements: 93, functions: 100, branches: 90, lines: 95 }
      }
    }
  }
});
