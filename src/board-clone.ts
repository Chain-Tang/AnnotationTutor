/** Board snapshots are plain data; older hosts retain the JSON fallback. */
export function cloneBoardValue<T>(value: T): T {
  return typeof globalThis.structuredClone === "function"
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T;
}
