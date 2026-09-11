import { defineConfig } from "vitest/config";

export default defineConfig({
  // The npm Obsidian package only ships types; DOM tests use a narrow host stub.
  resolve: { alias: { obsidian: new URL("./tests/helpers/obsidian.ts", import.meta.url).pathname } },
  test: {
    environment: "node",
    // Only the plugin's own suites; the default glob would also sweep cloned
    // research repos under .reference/.
    include: ["tests/**/*.test.ts"]
  }
});
