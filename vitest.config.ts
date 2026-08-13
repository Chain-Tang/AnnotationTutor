import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Only the plugin's own suites; the default glob would also sweep cloned
    // research repos under .reference/.
    include: ["tests/**/*.test.ts"]
  }
});
