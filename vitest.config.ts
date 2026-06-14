import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true
  },
  test: {
    environment: "node",
    // Review-run/SSE + SQLite tests are I/O-heavy; the 5s default flakes on
    // slower/cold CI runners (esp. macOS). Give them generous headroom.
    testTimeout: 30000,
    hookTimeout: 30000,
    exclude: [...configDefaults.exclude, "TutorLite/**"],
    coverage: {
      reporter: ["text", "json-summary"]
    }
  }
});
