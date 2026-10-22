import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SocketTransportError, streamChatCompletion, type ConnectionIssue, type HttpStream } from "../src/api-stream.js";
import { ConversationTransportError } from "../src/conversation-diagnostics.js";
import { ConversationRecovery } from "../src/conversation-recovery.js";

const streamOptions = { baseUrl: "https://test.example/v1", apiKey: "TEST", model: "test", messages: [], timeoutMs: 10_000 };
type Attempt = Parameters<Parameters<ConversationRecovery["run"]>[0]>[0];

async function connectionError(issue: ConnectionIssue = "reset", transport?: HttpStream): Promise<ConversationTransportError> {
  const result = await streamChatCompletion(streamOptions, transport ?? (async () => { throw new SocketTransportError(issue); }));
  return new ConversationTransportError(result);
}

function fixture(options: Partial<ConstructorParameters<typeof ConversationRecovery>[0]> = {}) {
  const controller = new AbortController();
  const ensureCurrent = vi.fn(async () => {});
  const reserveAdditional = vi.fn(async () => {});
  const onReconnect = vi.fn();
  const recovery = new ConversationRecovery({ signal: controller.signal, timeoutMs: 10_000, ensureCurrent, reserveAdditional, onReconnect, delayMs: 0, ...options });
  return { recovery, controller, ensureCurrent, reserveAdditional, onReconnect };
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  // Register rejection immediately, before advancing the reconnect timer.
  const outcome = promise.then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync();
  const result = await outcome;
  if ("error" in result) throw result.error;
  return result.value;
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T00:00:00Z")); });
afterEach(() => { vi.useRealTimers(); });

describe("one logical conversation's bounded connection recovery", () => {
  it("recovers a verified zero-byte failure once on a fresh connection with the remaining deadline", async () => {
    const { recovery, reserveAdditional, onReconnect } = fixture({ delayMs: 250 });
    reserveAdditional.mockImplementation(async () => { vi.setSystemTime(Date.now() + 50); });
    const attempts: Attempt[] = [];
    const presented = vi.fn();
    const send = vi.fn(async (attempt: Attempt) => {
      attempts.push(attempt);
      if (attempts.length === 1) {
        vi.setSystemTime(Date.now() + 1_200);
        throw await connectionError();
      }
      attempt.onDelta("Recovered answer");
      return { text: "Recovered answer" };
    });
    await expect(settle(recovery.run(send, presented))).resolves.toEqual({ text: "Recovered answer" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(attempts.map(({ timeoutMs, freshConnection }) => ({ timeoutMs, freshConnection }))).toEqual([
      { timeoutMs: 10_000, freshConnection: false }, { timeoutMs: 8_500, freshConnection: true }
    ]);
    expect(reserveAdditional).toHaveBeenCalledOnce(); expect(onReconnect).toHaveBeenCalledOnce();
    expect(presented.mock.calls).toEqual([["Recovered answer"]]);
  });

  it("stops after two consecutive verified connection failures", async () => {
    const { recovery, reserveAdditional, onReconnect } = fixture();
    const failure = await connectionError();
    const send = vi.fn(async () => { throw failure; });
    await expect(settle(recovery.run(send, vi.fn()))).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(2); expect(reserveAdditional).toHaveBeenCalledOnce(); expect(onReconnect).toHaveBeenCalledOnce();
  });

  it.each([false, true])("never replays received partial SSE bytes even before any text delta (response status: %s)", async hasResponse => {
    const failure = await connectionError("reset", async input => {
      if (hasResponse) input.onResponse({ status: 200, contentType: "text/event-stream" });
      input.onChunk(": 心跳\n\n");
      throw new SocketTransportError("reset");
    });
    expect(failure.receivedBytes).toBeGreaterThan(0);
    const { recovery, reserveAdditional, onReconnect } = fixture();
    const send = vi.fn(async () => { throw failure; });
    await expect(recovery.run(send, vi.fn())).rejects.toBe(failure);
    expect(send).toHaveBeenCalledOnce(); expect(reserveAdditional).not.toHaveBeenCalled(); expect(onReconnect).not.toHaveBeenCalled();
  });

  it.each(["partial answer", " ", "\n"])("never replays after forwarding any nonempty delta: %j", async delta => {
    const failure = await connectionError();
    const { recovery, reserveAdditional } = fixture();
    const present = vi.fn();
    const send = vi.fn(async (attempt: Attempt) => { attempt.onDelta(delta); throw failure; });
    await expect(recovery.run(send, present)).rejects.toBe(failure);
    expect(send).toHaveBeenCalledOnce(); expect(reserveAdditional).not.toHaveBeenCalled(); expect(present.mock.calls).toEqual([[delta]]);
  });

  it("ignores late callbacks from the failed and completed attempts", async () => {
    const failure = await connectionError();
    const { recovery } = fixture();
    const callbacks: Attempt["onDelta"][] = [];
    const present = vi.fn();
    const send = vi.fn(async (attempt: Attempt) => {
      callbacks.push(attempt.onDelta);
      if (callbacks.length === 1) throw failure;
      callbacks[0]!("Late failed attempt");
      attempt.onDelta("One answer");
      return { text: "One answer" };
    });
    await settle(recovery.run(send, present));
    callbacks[0]!("Late failure"); callbacks[1]!("Late success");
    expect(present.mock.calls).toEqual([["One answer"]]); expect(send).toHaveBeenCalledTimes(2);
  });

  it.each(["tls-certificate", "tls-handshake", "unknown"] as const)("does not reconnect for %s", async issue => {
    const failure = await connectionError(issue);
    const { recovery, reserveAdditional, onReconnect } = fixture();
    const send = vi.fn(async () => { throw failure; });
    await expect(recovery.run(send, vi.fn())).rejects.toBe(failure);
    expect(send).toHaveBeenCalledOnce(); expect(reserveAdditional).not.toHaveBeenCalled(); expect(onReconnect).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500, 503])("does not reconnect after any HTTP %s response", async status => {
    const result = await streamChatCompletion(streamOptions, async input => {
      input.onResponse({ status, contentType: "application/json" }); input.onChunk('{"error":{"message":"provider refusal"}}');
    });
    const failure = new ConversationTransportError(result);
    const { recovery, reserveAdditional } = fixture();
    const send = vi.fn(async () => { throw failure; });
    await expect(recovery.run(send, vi.fn())).rejects.toBe(failure);
    expect(send).toHaveBeenCalledOnce(); expect(reserveAdditional).not.toHaveBeenCalled();
  });

  it.each(["configuration", "untrusted-message", "untrusted-fields"])("does not reconnect on %s errors", async kind => {
    const result = kind === "configuration"
      ? await streamChatCompletion({ ...streamOptions, apiKey: "" }, vi.fn())
      : await streamChatCompletion(streamOptions, async () => {
        throw kind === "untrusted-fields" ? Object.assign(new Error("api-connection-failed"), { retryableConnection: true, connectionIssue: "reset" }) : new Error("api-connection-failed");
      });
    const failure = new ConversationTransportError(result);
    const { recovery, reserveAdditional } = fixture();
    const send = vi.fn(async () => { throw failure; });
    await expect(recovery.run(send, vi.fn())).rejects.toBe(failure);
    expect(send).toHaveBeenCalledOnce(); expect(reserveAdditional).not.toHaveBeenCalled();
  });

  it("does not send again when cancelled during the reconnect pause", async () => {
    const failure = await connectionError();
    const { recovery, controller, reserveAdditional } = fixture({ delayMs: 600 });
    const send = vi.fn(async () => { throw failure; });
    const promise = recovery.run(send, vi.fn());
    const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1); controller.abort(); await assertion;
    expect(send).toHaveBeenCalledOnce(); expect(reserveAdditional).not.toHaveBeenCalled();
  });

  it.each(["before-reserve", "after-reserve"])("does not send again if context changes %s", async stage => {
    const failure = await connectionError();
    const changed = new Error("annotation-parent-version-changed");
    let current = true;
    const ensureCurrent = vi.fn(async () => { if (!current) throw changed; });
    const reserveAdditional = vi.fn(async () => { if (stage === "after-reserve") current = false; });
    const { recovery } = fixture({ ensureCurrent, reserveAdditional, onReconnect: () => { if (stage === "before-reserve") current = false; } });
    const send = vi.fn(async () => { throw failure; });
    await expect(settle(recovery.run(send, vi.fn()))).rejects.toBe(changed);
    expect(send).toHaveBeenCalledOnce(); expect(reserveAdditional).toHaveBeenCalledTimes(stage === "before-reserve" ? 0 : 1);
  });

  it("does not send again when the additional model-call reservation is refused", async () => {
    const failure = await connectionError();
    const denied = new Error("learning-model-call-budget");
    const { recovery, reserveAdditional } = fixture();
    reserveAdditional.mockRejectedValue(denied);
    const send = vi.fn(async () => { throw failure; });
    await expect(settle(recovery.run(send, vi.fn()))).rejects.toBe(denied);
    expect(send).toHaveBeenCalledOnce(); expect(reserveAdditional).toHaveBeenCalledOnce();
  });

  it("does not send again after the logical turn deadline expires", async () => {
    const failure = await connectionError();
    const { recovery, reserveAdditional } = fixture({ timeoutMs: 100, delayMs: 600 });
    const send = vi.fn(async () => { throw failure; });
    await expect(settle(recovery.run(send, vi.fn()))).rejects.toThrow("api-request-timeout");
    expect(send).toHaveBeenCalledOnce(); expect(reserveAdditional).not.toHaveBeenCalled();
  });

  it("does not add a format correction after network recovery already consumed the second call", async () => {
    const failure = await connectionError();
    const { recovery, reserveAdditional } = fixture();
    const send = vi.fn(async () => { if (send.mock.calls.length === 1) throw failure; return { text: "bad format" }; });
    await expect(settle(recovery.run(send, vi.fn()))).resolves.toEqual({ text: "bad format" });
    await expect(recovery.reserveCorrection("teaching-reply-string-required")).rejects.toThrow("teaching-reply-string-required");
    expect(send).toHaveBeenCalledTimes(2); expect(reserveAdditional).toHaveBeenCalledOnce();
  });

  it("does not add a network replay after a format correction consumed the second call", async () => {
    const failure = await connectionError();
    const { recovery, reserveAdditional, onReconnect } = fixture();
    const send = vi.fn(async () => { if (send.mock.calls.length === 1) return { text: "bad format" }; throw failure; });
    await expect(recovery.run(send, vi.fn())).resolves.toEqual({ text: "bad format" });
    await recovery.reserveCorrection("teaching-reply-string-required");
    await expect(recovery.run(send, vi.fn())).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(2); expect(reserveAdditional).toHaveBeenCalledOnce(); expect(onReconnect).not.toHaveBeenCalled();
    await expect(recovery.run(send, vi.fn())).rejects.toThrow("learning-model-call-limit");
    expect(send).toHaveBeenCalledTimes(2);
  });
});
