import { packedPressureOutline, type PackedPressureStroke } from "./board-pressure-geometry.js";

// Bundled offline into a Blob worker. No Node, network, Vault or model access.
const worker = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; strokes: PackedPressureStroke[] }>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
};
worker.onmessage = event => {
  const { id, strokes } = event.data;
  try {
    if (!Array.isArray(strokes) || strokes.length > 128) throw Error("outline-batch-limit");
    let points = 0;
    for (const stroke of strokes) {
      if (!(stroke.samples instanceof Float64Array) || stroke.samples.length % 3) throw Error("outline-samples");
      points += stroke.samples.length / 3;
      if (points > 64_000) throw Error("outline-point-limit");
    }
    const outlines = strokes.map(stroke => ({ id: stroke.id, points: packedPressureOutline(stroke) }));
    worker.postMessage({ id, outlines }, outlines.map(outline => outline.points.buffer));
  } catch {
    worker.postMessage({ id, error: "outline-worker-failed" }, []);
  }
};
