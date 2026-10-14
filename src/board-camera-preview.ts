export type BoardCamera = {
  pan: { x: number; y: number };
  zoom: number;
  rotation?: number;
  mirrored?: boolean;
  center?: { x: number; y: number };
};

/** Reprojects the last complete viewport while an infinite canvas is moving. */
export function boardCameraPreviewTransform(from: BoardCamera, to: BoardCamera): string | null {
  if (![from.pan.x, from.pan.y, from.zoom, to.pan.x, to.pan.y, to.zoom].every(Number.isFinite) || from.zoom <= 0 || to.zoom <= 0) return null;
  if ((from.rotation ?? 0) !== (to.rotation ?? 0) || !!from.mirrored !== !!to.mirrored) return null;
  const center = from.center ?? { x: 0, y: 0 };
  const angle = from.rotation ?? 0;
  const cosine = Math.cos(angle), sine = Math.sin(angle), mirror = from.mirrored ? -1 : 1;
  const origin = (pan: { x: number; y: number }) => {
    const x = pan.x - center.x, y = pan.y - center.y;
    return { x: center.x + mirror * cosine * x - sine * y, y: center.y + mirror * sine * x + cosine * y };
  };
  const scale = to.zoom / from.zoom;
  const before = origin(from.pan), after = origin(to.pan);
  const x = after.x - scale * before.x;
  const y = after.y - scale * before.y;
  return `matrix(${scale}, 0, 0, ${scale}, ${x}, ${y})`;
}
