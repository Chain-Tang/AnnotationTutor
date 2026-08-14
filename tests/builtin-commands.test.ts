import { describe, expect, it } from "vitest";
import {
  BUILTIN_COMMANDS,
  BUILTIN_COMMAND_DIR,
  builtinCommandFile
} from "../src/builtin-commands.js";

describe("BUILTIN_COMMANDS", () => {
  it("ships the excalidraw-diagram command", () => {
    const diagram = BUILTIN_COMMANDS.find(
      (command) => command.name === "excalidraw-diagram"
    );
    expect(diagram).toBeDefined();
    expect(diagram!.description).not.toBe("");
    // The prompt body carries the hard format constraints the guard repairs.
    expect(diagram!.body).toContain("excalidraw-plugin: parsed");
    expect(diagram!.body).toContain("boundElements");
    expect(diagram!.body).toContain("fontFamily: 5");
  });

  it("keeps command names slash-safe", () => {
    for (const command of BUILTIN_COMMANDS) {
      expect(command.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it("ships the read-only find-paper command", () => {
    const finder = BUILTIN_COMMANDS.find(
      (command) => command.name === "find-paper"
    );
    expect(finder).toBeDefined();
    // The agent must stay read-only: file tools only, no shell, no writes.
    expect(finder!.body).toContain("read-only");
    expect(finder!.body).toContain("*.pdf");
    expect(finder!.body).not.toMatch(/\bbash\b/i);
  });
});

describe("builtinCommandFile", () => {
  it("renders the OpenCode command frontmatter plus body", () => {
    const command = BUILTIN_COMMANDS[0]!;
    const file = builtinCommandFile(command);
    expect(file.startsWith(`---\ndescription: ${command.description}\n---\n\n`)).toBe(
      true
    );
    expect(file).toContain(command.body);
    expect(file.endsWith("\n")).toBe(true);
  });
});

describe("BUILTIN_COMMAND_DIR", () => {
  it("targets OpenCode's command folder", () => {
    expect(BUILTIN_COMMAND_DIR).toBe(".opencode/command");
  });
});
