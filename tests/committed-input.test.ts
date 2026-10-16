// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindCommittedInput, bindSearchInput, commitSettingsInputs } from "../src/committed-input.js";

afterEach(() => { document.body.replaceChildren(); });
function fixture(initial = "before") {
  const input = document.createElement("input");
  input.value = initial; document.body.append(input);
  const save = vi.fn(async (_value: string) => {}), onError = vi.fn();
  bindCommittedInput(input, { read: () => initial, parse: value => value.trim(), save, onError });
  return { input, save, onError };
}
function enter(input: HTMLInputElement, isComposing = false) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing, bubbles: true }));
}

describe("committed ordinary settings inputs", () => {
  it("saves twenty characters once and deduplicates Enter followed by blur", async () => {
    const { input, save } = fixture();
    for (let char = 1; char <= 20; char++) { input.value = "x".repeat(char); input.dispatchEvent(new Event("input")); }
    expect(save).not.toHaveBeenCalled();
    enter(input); input.dispatchEvent(new Event("blur"));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenLastCalledWith("x".repeat(20));
    input.dispatchEvent(new Event("blur")); await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);
  });
  it("skips untouched and equivalent normalized values", async () => {
    const { input, save } = fixture();
    input.dispatchEvent(new Event("blur")); input.value = " before "; enter(input);
    await Promise.resolve();
    expect(save).not.toHaveBeenCalled(); expect(input.value).toBe("before");
  });
  it("preserves a failed draft and retries the same value", async () => {
    const { input, save, onError } = fixture();
    save.mockRejectedValueOnce(new Error("disk busy")); input.value = "after"; enter(input);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(input.value).toBe("after"); expect(input.getAttribute("aria-invalid")).toBe("true");
    enter(input); await vi.waitFor(() => expect(input.hasAttribute("aria-invalid")).toBe(false));
    expect(save).toHaveBeenCalledTimes(2); expect(input.value).toBe("after");
  });
  it("does not overwrite new typing while a previous save completes", async () => {
    const input = document.createElement("input"); document.body.append(input);
    let resolve!: () => void;
    const save = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    bindCommittedInput(input, { read: () => "", parse: value => value.trim(), save });
    input.value = "first"; enter(input); await Promise.resolve();
    input.value = "second draft"; resolve(); await Promise.resolve(); await Promise.resolve();
    expect(input.value).toBe("second draft");
  });
  it("honors IME, multiline text and obsolete connection bindings", async () => {
    const { input, save } = fixture();
    input.value = "中文"; input.dispatchEvent(new CompositionEvent("compositionstart")); enter(input, true);
    input.dispatchEvent(new Event("blur")); await Promise.resolve(); expect(save).not.toHaveBeenCalled();
    input.dispatchEvent(new CompositionEvent("compositionend")); enter(input);
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith("中文"));
    const obsolete = document.createElement("input"), blocked = vi.fn(async () => {});
    bindCommittedInput(obsolete, { read: () => "", parse: value => value, save: blocked, isCurrent: () => false });
    obsolete.value = "late model"; enter(obsolete); await Promise.resolve(); expect(blocked).not.toHaveBeenCalled();
    const area = document.createElement("textarea"), multiline = vi.fn(async () => {});
    bindCommittedInput(area, { read: () => "", parse: value => value, save: multiline });
    area.value = "first line"; area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(multiline).not.toHaveBeenCalled();
  });
  it("flushes only ordinary bound controls before changing an engine", async () => {
    const { input, save } = fixture(); const password = document.createElement("input"); password.type = "password";
    document.body.append(password); input.value = "model"; password.value = "credential draft";
    expect(await commitSettingsInputs(document.body)).toBe(true);
    expect(save).toHaveBeenCalledTimes(1); expect(password.value).toBe("credential draft");
  });
});

describe("composition-safe list search", () => {
  it("waits for complete Chinese input and applies it once without replacing the control", () => {
    const input = document.createElement("input"), apply = vi.fn(); document.body.append(input);
    bindSearchInput(input, apply);
    input.dispatchEvent(new CompositionEvent("compositionstart")); input.value = "中"; input.dispatchEvent(new Event("input"));
    input.value = "中文"; input.dispatchEvent(new Event("input")); expect(apply).not.toHaveBeenCalled();
    input.dispatchEvent(new CompositionEvent("compositionend")); input.dispatchEvent(new Event("input"));
    expect(apply).toHaveBeenCalledTimes(1); expect(apply).toHaveBeenCalledWith("中文");
    expect(document.body.firstElementChild).toBe(input);
  });
});


it("flushes fields in DOM order and stops before the second save on failure", async () => {
  const first = document.createElement("input"), second = document.createElement("input");
  const writes: string[] = [];
  document.body.append(first, second);
  bindCommittedInput(first, { read: () => "", parse: value => value, save: async () => { writes.push("first"); throw new Error("disk"); } });
  bindCommittedInput(second, { read: () => "", parse: value => value, save: async () => { writes.push("second"); } });
  first.value = "a"; second.value = "b";
  expect(await commitSettingsInputs(document.body)).toBe(false);
  expect(writes).toEqual(["first"]); expect(second.value).toBe("b");
});
