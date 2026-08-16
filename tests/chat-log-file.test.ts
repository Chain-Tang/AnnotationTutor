import { describe, expect, it } from "vitest";
import {
  capChatLog,
  chatTitleFrom,
  parseChatLogFile,
  parseChatLogHead,
  serializeChatLog
} from "../src/markdown/chat-log-file.js";
import type { ChatLog, ChatLogTurn, MemoryCell } from "../src/model.js";
import { serializeMemoryCell } from "../src/markdown/memory-cell-file.js";

function cell(): MemoryCell {
  return {
    id: "MEM-ann-20260615-001",
    type: "understanding",
    concept: "Attention",
    status: "new",
    summary: "Attention weights several positions at once.",
    sourceAnnotations: ["ANN-20260615-001"],
    tags: ["ml"],
    confidence: 0.6,
    createdAt: "2026-06-15T10:00:00.000Z",
    updatedAt: "2026-06-15T10:00:00.000Z"
  };
}

function turn(
  role: ChatLogTurn["role"],
  text: string,
  at = "2026-06-15T10:00:00.000Z"
): ChatLogTurn {
  return { role, text, at };
}

function log(overrides: Partial<ChatLog> = {}): ChatLog {
  return {
    id: "CHAT-20260615-001",
    title: "Question about attention",
    engine: "opencode",
    mode: "ask",
    status: "active",
    turns: [
      turn("user", "What is attention?"),
      turn("assistant", "Attention weights several positions at once.")
    ],
    createdAt: "2026-06-15T10:00:00.000Z",
    updatedAt: "2026-06-15T10:01:00.000Z",
    ...overrides
  };
}

describe("chat log file", () => {
  it("round-trips a session with CJK text, blank lines, and quoted markdown", () => {
    const session = log({
      turns: [
        turn("user", "什么是注意力？\n\n> quoted line\n- bullet"),
        turn("assistant", "注意力把每个位置加权求和。\n\n| a | b |\n| - | - |"),
        turn("user", "### not a heading boundary")
      ]
    });
    const serialized = serializeChatLog(session);

    const parsed = parseChatLogFile(serialized);
    expect(parsed).toEqual(session);
    // Idempotent: re-serializing the parse reproduces the file byte-for-byte.
    expect(serializeChatLog(parsed!)).toBe(serialized);
  });

  it("round-trips a multi-turn session with one turn per role interleaved", () => {
    const turns: ChatLogTurn[] = [];
    for (let i = 0; i < 12; i += 1) {
      turns.push(turn("user", `question ${i}`));
      turns.push(turn("assistant", `answer ${i}`));
    }
    const session = log({ turns });
    expect(parseChatLogFile(serializeChatLog(session))?.turns).toHaveLength(24);
  });

  it("rejects files that are not chat logs", () => {
    expect(parseChatLogFile(serializeMemoryCell(cell()))).toBeNull();
    expect(parseChatLogHead(serializeMemoryCell(cell()))).toBeNull();
    expect(parseChatLogFile("no frontmatter at all")).toBeNull();
  });

  it("parses the head of a truncated file (frontmatter only)", () => {
    const serialized = serializeChatLog(log());
    // Simulate a body cut off after the frontmatter: keep everything up to the
    // end of the frontmatter block only.
    const endOfFrontmatter = serialized.indexOf("---", 4) + 3;
    const truncated = serialized.slice(0, endOfFrontmatter);

    const head = parseChatLogHead(truncated);
    expect(head?.id).toBe("CHAT-20260615-001");
    expect(head?.turns).toBe(2);
    // The full parse of a truncated file yields an empty (but valid) session.
    expect(parseChatLogFile(truncated)?.turns).toEqual([]);
  });

  it("caps by turn count, keeping the tail", () => {
    const turns = Array.from({ length: 60 }, (_, i) => turn("user", `t${i}`));
    const { turns: kept, truncated } = capChatLog(turns, 50, 100_000);
    expect(kept).toHaveLength(50);
    expect(truncated).toBe(10);
    expect(kept[0]?.text).toBe("t10");
    expect(kept[49]?.text).toBe("t59");
  });

  it("caps by total characters but always keeps at least one turn", () => {
    const turns = [
      turn("user", "a".repeat(1000)),
      turn("assistant", "b".repeat(1000)),
      turn("user", "c".repeat(1000))
    ];
    const fits = capChatLog(turns, 50, 1500);
    // 3000 > 1500 -> drop one; 2000 > 1500 -> drop one; 1000 fits.
    expect(fits.turns).toHaveLength(1);
    expect(fits.turns[0]?.text![0]).toBe("c");
    expect(fits.truncated).toBe(2);

    const floor = capChatLog(turns, 50, 10);
    // Even a tiny cap keeps a single turn.
    expect(floor.turns).toHaveLength(1);
    expect(floor.truncated).toBe(2);
  });

  it("returns everything unchanged when within both caps", () => {
    const turns = [turn("user", "hello"), turn("assistant", "hi")];
    expect(capChatLog(turns, 2, 100)).toEqual({ turns, truncated: 0 });
  });

  it("derives a CJK-safe title from the first message", () => {
    expect(chatTitleFrom("hello")).toBe("hello");
    expect(chatTitleFrom("  multiple   spaces\nand lines ")).toBe(
      "multiple spaces and lines"
    );
    const long = "什".repeat(60);
    const title = chatTitleFrom(long);
    expect(title).toHaveLength(40);
    expect(title.endsWith("…")).toBe(true);
    expect(chatTitleFrom("")).toBe("");
  });
});
