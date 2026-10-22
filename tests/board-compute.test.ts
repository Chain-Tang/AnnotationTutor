import { describe, expect, it } from "vitest";
import { BoardComputeService } from "../src/board-compute.js";

describe("board compute fallback", () => {
  it("derives simplified geometry when Worker is unavailable", async () => {
    const service = new BoardComputeService();
    const result = await service.derive({
      id: "stroke", width: 100, height: 1,
      points: Array.from({ length: 101 }, (_, x) => ({ x, y: 0 })),
    });
    expect(result.kind).toBe("underline");
    expect(result.simplified.length).toBeLessThanOrEqual(101);
    service.dispose();
  });
});
