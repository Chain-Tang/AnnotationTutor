import { describe, expect, it } from "vitest";
import {
  buildShellProbe,
  defaultShell,
  mergeShellPath,
  parseShellProbe
} from "../src/opencode-setup.js";

describe("defaultShell", () => {
  it("prefers $SHELL when set", () => {
    expect(defaultShell("darwin", { SHELL: "/usr/bin/fish" })).toBe(
      "/usr/bin/fish"
    );
    expect(defaultShell("linux", { SHELL: "  /bin/bash  " })).toBe("/bin/bash");
  });

  it("falls back to zsh on macOS and bash elsewhere", () => {
    expect(defaultShell("darwin", {})).toBe("/bin/zsh");
    expect(defaultShell("linux", {})).toBe("/bin/bash");
    expect(defaultShell("linux", { SHELL: "   " })).toBe("/bin/bash");
  });
});

describe("buildShellProbe", () => {
  it("runs a login+interactive shell that prints both sentinels", () => {
    const { command, args } = buildShellProbe("/bin/zsh");
    expect(command).toBe("/bin/zsh");
    expect(args[0]).toBe("-ilc");
    expect(args[1]).toContain("__ATL_PATH__:");
    expect(args[1]).toContain("__ATL_BIN__:");
    expect(args[1]).toContain("command -v opencode");
  });

  it("honors a custom binary name", () => {
    const { args } = buildShellProbe("/bin/bash", "my-cli");
    expect(args[1]).toContain("command -v my-cli");
  });

  it("rejects an unsafe binary name and uses opencode", () => {
    const { args } = buildShellProbe("/bin/bash", "opencode; rm -rf /");
    expect(args[1]).toContain("command -v opencode");
    expect(args[1]).not.toContain("rm -rf");
  });
});

describe("parseShellProbe", () => {
  it("extracts the PATH and binary path from sentinel lines", () => {
    const out = [
      "__ATL_PATH__:/opt/homebrew/bin:/usr/bin",
      "__ATL_BIN__:/Users/x/.bun/bin/opencode"
    ].join("\n");
    expect(parseShellProbe(out)).toEqual({
      path: "/opt/homebrew/bin:/usr/bin",
      opencode: "/Users/x/.bun/bin/opencode"
    });
  });

  it("ignores noisy shell startup output around the sentinels", () => {
    const out = [
      "Welcome back!",
      "nvm: loaded",
      "__ATL_PATH__:/usr/local/bin",
      "some other chatter",
      "__ATL_BIN__:/usr/local/bin/opencode"
    ].join("\n");
    expect(parseShellProbe(out)).toEqual({
      path: "/usr/local/bin",
      opencode: "/usr/local/bin/opencode"
    });
  });

  it("returns an empty binary when command -v found nothing", () => {
    const out = ["__ATL_PATH__:/usr/bin", "__ATL_BIN__:"].join("\n");
    expect(parseShellProbe(out)).toEqual({ path: "/usr/bin", opencode: "" });
  });

  it("returns empty fields when no sentinels are present", () => {
    expect(parseShellProbe("nothing useful here")).toEqual({
      path: "",
      opencode: ""
    });
  });
});

describe("mergeShellPath", () => {
  it("prepends new dirs ahead of the current PATH", () => {
    expect(mergeShellPath("/usr/bin", "/opt/homebrew/bin:/usr/bin")).toBe(
      "/opt/homebrew/bin:/usr/bin"
    );
  });

  it("de-duplicates, ignoring trailing slashes", () => {
    expect(mergeShellPath("/usr/bin/", "/usr/bin:/new/bin")).toBe(
      "/new/bin:/usr/bin/"
    );
  });

  it("returns the current PATH unchanged when nothing is new", () => {
    expect(mergeShellPath("/usr/bin:/bin", "/bin:/usr/bin")).toBe(
      "/usr/bin:/bin"
    );
  });

  it("handles an empty current PATH", () => {
    expect(mergeShellPath("", "/a:/b")).toBe("/a:/b");
  });

  it("honors a custom separator (Windows)", () => {
    expect(mergeShellPath("C:\\bin", "D:\\bin;C:\\bin", ";")).toBe(
      "D:\\bin;C:\\bin"
    );
  });
});
