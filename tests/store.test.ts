import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApp, type MockVault } from "./helpers/obsidian-mock.js";
import type { App } from "obsidian";
import type { AnnotationTutorLiteSettings } from "../src/settings.js";
import type {
  ChatLog,
  LearnerProfile,
  MemoryCell,
  MemoryProposal,
  Scene
} from "../src/model.js";
import { serializeMemoryCell } from "../src/markdown/memory-cell-file.js";
import { parseProfileFile, serializeProfile } from "../src/markdown/profile-file.js";
import { parseSceneFile, serializeScene } from "../src/markdown/scene-file.js";
import { serializeProposal } from "../src/markdown/proposal-file.js";

// The store imports the Obsidian runtime; swap it for the in-memory mock so its
// file I/O can be exercised end-to-end under vitest's node environment.
vi.mock("obsidian", () => import("./helpers/obsidian-mock.js"));

// Imported after the mock is registered so the store binds to the mock classes.
const { VaultStore } = await import("../src/store.js");

const MANIFEST = "annotation-tutor-lite";
const NOW = "2026-06-07T10:00:00.000Z";

function makeStore(): { store: InstanceType<typeof VaultStore>; vault: MockVault } {
  const app = createMockApp();
  const settings = {
    memoryRoot: "Agent Memory",
    allowPreferenceWrites: false
  } as unknown as AnnotationTutorLiteSettings;
  const store = new VaultStore(app as unknown as App, MANIFEST, () => settings);
  return { store, vault: app.vault };
}

function attentionCell(id: string): MemoryCell {
  return {
    id,
    type: "understanding",
    concept: "Attention",
    status: "stable",
    summary: "The learner understands attention.",
    sourceAnnotations: ["ANN-20260607-001"],
    tags: [],
    confidence: 0.9,
    createdAt: NOW,
    updatedAt: NOW
  };
}

function memoryCellProposal(
  id: string,
  targetPath: string,
  candidate: string
): MemoryProposal {
  return {
    id,
    operation: "create",
    targetKind: "memory-cell",
    targetPath,
    status: "pending",
    candidate,
    createdAt: NOW
  };
}

function topicScene(
  id: string,
  status: "active" | "archived" = "active"
): Scene {
  return {
    id,
    type: "topic",
    title: "Attention",
    status,
    summary: "Grouped understanding of attention.",
    cells: ["CELL-attention-001", "CELL-attention-002"],
    tags: [],
    createdAt: NOW,
    updatedAt: NOW
  };
}

function learnerProfileWithClaims(): LearnerProfile {
  return {
    id: "learner-profile",
    kind: "learner-profile",
    title: "Learner Profile",
    status: "active",
    summary: "Auditable learner profile.",
    claims: [
      {
        statement: "Understands attention.",
        evidence: ["CELL-attention-001", "CELL-attention-002"]
      },
      {
        statement: "Understands backprop.",
        evidence: ["CELL-backprop-001", "CELL-backprop-002"]
      }
    ],
    tags: [],
    updatedAt: NOW
  };
}

describe("VaultStore.approveProposal scene sync", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("re-derives auto scenes after approving a memory-cell proposal", async () => {
    const { store, vault } = makeStore();
    // A first cell about "Attention" already lives on disk.
    await vault.create(
      "Agent Memory/memory-cells/CELL-attention-001.md",
      serializeMemoryCell(attentionCell("CELL-attention-001"))
    );
    // A pending proposal adds a second "Attention" cell.
    await vault.create(
      "Agent Memory/proposals/pending/PROP-attention-002.md",
      serializeProposal(
        memoryCellProposal(
          "PROP-attention-002",
          "memory-cells/CELL-attention-002.md",
          serializeMemoryCell(attentionCell("CELL-attention-002"))
        )
      )
    );
    // No scene yet: a single "Attention" cell is not enough to group.
    expect(vault.files.has("Agent Memory/scenes/SCENE-Attention.md")).toBe(false);

    const result = await store.approveProposal("PROP-attention-002");

    expect(result).toEqual({ ok: true });
    // The candidate cell was written...
    expect(
      vault.files.has("Agent Memory/memory-cells/CELL-attention-002.md")
    ).toBe(true);
    // ...and the two same-concept cells now derive an auto scene.
    expect(vault.files.has("Agent Memory/scenes/SCENE-Attention.md")).toBe(true);
  });

  it("does not re-derive scenes when the approved proposal is not a memory cell", async () => {
    const { store, vault } = makeStore();
    // Two "Attention" cells already exist, so scene derivation *would* fire if
    // it ran — but no scene file is present yet.
    await vault.create(
      "Agent Memory/memory-cells/CELL-attention-001.md",
      serializeMemoryCell(attentionCell("CELL-attention-001"))
    );
    await vault.create(
      "Agent Memory/memory-cells/CELL-attention-002.md",
      serializeMemoryCell(attentionCell("CELL-attention-002"))
    );
    const profile: LearnerProfile = {
      id: "learner-profile",
      kind: "learner-profile",
      title: "Learner Profile",
      status: "active",
      summary: "Auditable learner profile.",
      claims: [],
      tags: [],
      updatedAt: NOW
    };
    await vault.create(
      "Agent Memory/proposals/pending/PROP-profile-001.md",
      serializeProposal({
        id: "PROP-profile-001",
        operation: "create",
        targetKind: "learner-profile",
        targetPath: "profiles/learner-profile.md",
        status: "pending",
        candidate: serializeProfile(profile),
        createdAt: NOW
      })
    );

    const result = await store.approveProposal("PROP-profile-001");

    expect(result.ok).toBe(true);
    // The profile write happened, but scene sync was skipped.
    expect(vault.files.has("Agent Memory/profiles/learner-profile.md")).toBe(true);
    expect(vault.files.has("Agent Memory/scenes/SCENE-Attention.md")).toBe(false);
  });
});

describe("VaultStore.createScene", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("writes a new hand-authored scene file that round-trips", async () => {
    const { store, vault } = makeStore();
    const scene = topicScene("SCENE-Attention");
    await store.createScene(scene);
    const path = "Agent Memory/scenes/SCENE-Attention.md";
    expect(vault.files.has(path)).toBe(true);
    expect(parseSceneFile(vault.files.get(path) ?? "")).toEqual(scene);
  });
});

describe("VaultStore.archiveScene", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("marks an existing scene archived and returns the updated scene", async () => {
    const { store, vault } = makeStore();
    await vault.create(
      "Agent Memory/scenes/SCENE-Attention.md",
      serializeScene(topicScene("SCENE-Attention"))
    );

    const result = await store.archiveScene("SCENE-Attention");

    expect(result?.status).toBe("archived");
    const onDisk = parseSceneFile(
      vault.files.get("Agent Memory/scenes/SCENE-Attention.md") ?? ""
    );
    expect(onDisk?.status).toBe("archived");
  });

  it("returns null when the scene file is missing", async () => {
    const { store } = makeStore();
    expect(await store.archiveScene("SCENE-missing")).toBeNull();
  });
});

describe("VaultStore.deleteProfileClaim", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("removes a single claim by index and keeps the rest", async () => {
    const { store, vault } = makeStore();
    await vault.create(
      "Agent Memory/profiles/learner-profile.md",
      serializeProfile(learnerProfileWithClaims())
    );

    const result = await store.deleteProfileClaim("learner-profile", 0);

    expect(result?.claims).toHaveLength(1);
    expect(result?.claims[0]?.statement).toBe("Understands backprop.");
    const onDisk = parseProfileFile(
      vault.files.get("Agent Memory/profiles/learner-profile.md") ?? ""
    );
    expect(onDisk?.claims).toHaveLength(1);
  });

  it("leaves the profile untouched when the index is out of range", async () => {
    const { store, vault } = makeStore();
    await vault.create(
      "Agent Memory/profiles/learner-profile.md",
      serializeProfile(learnerProfileWithClaims())
    );

    const result = await store.deleteProfileClaim("learner-profile", 9);

    expect(result).toBeNull();
    const onDisk = parseProfileFile(
      vault.files.get("Agent Memory/profiles/learner-profile.md") ?? ""
    );
    expect(onDisk?.claims).toHaveLength(2);
  });

  it("returns null when the profile file is missing", async () => {
    const { store } = makeStore();
    expect(await store.deleteProfileClaim("preferences", 0)).toBeNull();
  });
});

describe("VaultStore chat logs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function makeChatStore(
    chatLogKeepSessions = 30
  ): { store: InstanceType<typeof VaultStore>; vault: MockVault } {
    const app = createMockApp();
    const settings = {
      memoryRoot: "Agent Memory",
      chatLogKeepSessions
    } as unknown as AnnotationTutorLiteSettings;
    const store = new VaultStore(app as unknown as App, MANIFEST, () => settings);
    return { store, vault: app.vault };
  }

  function chatLog(
    id: string,
    updatedAt: string,
    overrides: Partial<ChatLog> = {}
  ): ChatLog {
    return {
      id,
      title: `Session ${id}`,
      engine: "api",
      mode: "ask",
      status: "active",
      turns: [
        { role: "user", text: "What is attention?", at: updatedAt },
        { role: "assistant", text: "A weighting mechanism.", at: updatedAt }
      ],
      createdAt: updatedAt,
      updatedAt,
      ...overrides
    };
  }

  it("saves sessions, lists heads newest-first, and loads one back", async () => {
    const { store, vault } = makeChatStore();
    const oldest = chatLog("CHAT-20260607-001", "2026-06-07T10:00:00.000Z");
    const newest = chatLog("CHAT-20260608-001", "2026-06-08T10:00:00.000Z");
    await store.saveChatLog(oldest);
    await store.saveChatLog(newest);

    const heads = await store.listChatLogs();
    expect(heads.map((head) => head.id)).toEqual([
      "CHAT-20260608-001",
      "CHAT-20260607-001"
    ]);
    expect(heads[0]?.turns).toBe(2);
    expect(vault.files.has("Agent Memory/chats/CHAT-20260608-001.md")).toBe(
      true
    );
    expect(await store.loadChatLog("CHAT-20260608-001")).toEqual(newest);
    expect(await store.loadChatLog("CHAT-missing")).toBeNull();
  });

  it("deletes one saved session", async () => {
    const { store, vault } = makeChatStore();
    await store.saveChatLog(chatLog("CHAT-20260607-001", "2026-06-07T10:00:00.000Z"));
    await store.saveChatLog(chatLog("CHAT-20260608-001", "2026-06-08T10:00:00.000Z"));

    await store.deleteChatLog("CHAT-20260607-001");

    expect((await store.listChatLogs()).map((head) => head.id)).toEqual([
      "CHAT-20260608-001"
    ]);
    expect(vault.files.has("Agent Memory/chats/CHAT-20260607-001.md")).toBe(false);
  });

  it("clears every saved session", async () => {
    const { store } = makeChatStore();
    await store.saveChatLog(chatLog("CHAT-20260607-001", "2026-06-07T10:00:00.000Z"));
    await store.saveChatLog(chatLog("CHAT-20260608-001", "2026-06-08T10:00:00.000Z"));

    await store.clearChatLogs();

    expect(await store.listChatLogs()).toEqual([]);
  });

  it("prunes the oldest sessions beyond chatLogKeepSessions on save", async () => {
    const { store, vault } = makeChatStore(2);
    await store.saveChatLog(chatLog("CHAT-20260607-001", "2026-06-07T10:00:00.000Z"));
    await store.saveChatLog(chatLog("CHAT-20260608-001", "2026-06-08T10:00:00.000Z"));
    // The third save exceeds the keep limit and prunes the oldest file.
    await store.saveChatLog(chatLog("CHAT-20260609-001", "2026-06-09T10:00:00.000Z"));

    expect((await store.listChatLogs()).map((head) => head.id)).toEqual([
      "CHAT-20260609-001",
      "CHAT-20260608-001"
    ]);
    expect(vault.files.has("Agent Memory/chats/CHAT-20260607-001.md")).toBe(false);
  });
});
