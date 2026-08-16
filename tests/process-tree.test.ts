import { describe, expect, it } from "vitest";
import { treeKillSpec } from "../src/process-tree.js";

describe("treeKillSpec", () => {
  it("returns a taskkill /T /F spec on Windows", () => {
    // Windows has no process groups, so a whole-tree kill shells out to taskkill.
    expect(treeKillSpec(1234, "win32")).toEqual({
      command: "taskkill",
      args: ["/pid", "1234", "/T", "/F"]
    });
  });

  it("returns null on non-Windows platforms", () => {
    // Elsewhere the caller signals the process directly; no helper is needed.
    expect(treeKillSpec(1234, "linux")).toBeNull();
    expect(treeKillSpec(1234, "darwin")).toBeNull();
  });

  it("returns null for an invalid or missing pid", () => {
    expect(treeKillSpec(undefined, "win32")).toBeNull();
    expect(treeKillSpec(0, "win32")).toBeNull();
    expect(treeKillSpec(-5, "win32")).toBeNull();
    expect(treeKillSpec(3.5, "win32")).toBeNull();
  });
});
