/** Ordinary settings drafts commit on blur/Enter, never on each keystroke. */
type Input = HTMLInputElement | HTMLTextAreaElement;
export type CommittedInputOptions<Value> = {
  read: () => Value;
  parse: (draft: string) => Value;
  format?: (value: Value) => string;
  equal?: (left: Value, right: Value) => boolean;
  save: (value: Value) => Promise<void>;
  isCurrent?: () => boolean;
  onError?: (error: unknown) => void;
};
const commits = new WeakMap<Input, () => Promise<boolean>>();

function announceCommitted(input: Input): void {
  const OwnerEvent = input.ownerDocument.defaultView?.Event ?? Event;
  input.dispatchEvent(new OwnerEvent("atl-settings-committed"));
}

export function bindCommittedInput<Value>(input: Input, options: CommittedInputOptions<Value>): void {
  const format = options.format ?? String;
  const equal = options.equal ?? Object.is;
  let committed = options.read();
  let pending: { value: Value; promise: Promise<boolean> } | undefined;
  let composing = false;
  let failed = false;
  const commit = async (): Promise<boolean> => {
    if (composing || options.isCurrent?.() === false) return false;
    const raw = input.value;
    let value: Value;
    try { value = options.parse(raw); } catch (error) {
      failed = true; input.setAttribute("aria-invalid", "true"); input.dataset["atlCommitState"] = "failed";
      options.onError?.(error); return false;
    }
    if (pending) {
      if (equal(value, pending.value)) return pending.promise;
      if (!await pending.promise) return false;
      return commit();
    }
    if (equal(value, committed) || (!failed && equal(value, options.read()))) {
      committed = value;
      failed = false;
      input.removeAttribute("aria-invalid");
      delete input.dataset["atlCommitState"];
      if (input.value === raw) input.value = format(value);
      announceCommitted(input);
      return true;
    }
    input.dataset["atlCommitState"] = "pending";
    const save = Promise.resolve().then(() => options.save(value)).then(() => {
      committed = value;
      failed = false;
      input.removeAttribute("aria-invalid");
      delete input.dataset["atlCommitState"];
      if (input.value === raw) {
        input.value = format(value);
        announceCommitted(input);
      }
      return true;
    }, error => {
      // Leave the user's draft intact; the next blur/Enter retries this value.
      failed = true;
      input.dataset["atlCommitState"] = "failed";
      input.setAttribute("aria-invalid", "true");
      options.onError?.(error);
      return false;
    }).finally(() => { pending = undefined; });
    pending = { value, promise: save };
    return save;
  };
  commits.set(input, commit);
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; });
  input.addEventListener("blur", () => { void commit(); });
  input.addEventListener("keydown", event => {
    const key = event as KeyboardEvent;
    if (key.key !== "Enter" || key.isComposing || composing || input.tagName === "TEXTAREA") return;
    event.preventDefault();
    void commit();
  });
}

/** Flush visible ordinary drafts before changing the engine/model binding. */
export async function commitSettingsInputs(root: HTMLElement): Promise<boolean> {
  for (const input of root.querySelectorAll<Input>("input, textarea")) {
    const commit = commits.get(input);
    if (commit && !await commit()) return false;
  }
  return true;
}

/** Search stays mounted while IME owns its composition buffer. */
export function bindSearchInput(input: HTMLInputElement, apply: (value: string) => void): void {
  let composing = false;
  let applied = input.value;
  const update = (): void => {
    if (composing || applied === input.value) return;
    applied = input.value;
    apply(applied);
  };
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; update(); });
  input.addEventListener("input", update);
  input.addEventListener("change", update);
}
