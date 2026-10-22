import { communicationBytes, emptyCommunicationSnapshot, TUTOR_COMMUNICATION_LIMITS, validateCommunicationSnapshot, type CommunicationPersistence, type CommunicationSnapshot } from "./tutor-communication.js";

/** The host supplies a fixed private state path. compareWrite must compare and
 * replace atomically (and reject on mismatch); the core never chooses vaults. */
export type CommunicationStoreIO = {
  read(path: string): Promise<string | null>;
  compareWrite(path: string, previous: string | null, next: string): Promise<void>;
};
export class TutorCommunicationStore implements CommunicationPersistence {
  private tail: Promise<unknown> = Promise.resolve();
  private lastRevision = -1;
  constructor(private readonly io: CommunicationStoreIO, readonly path: string) {}
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => {}).then(run); this.tail = next; return next;
  }
  private async load(): Promise<{ raw: string | null; snapshot: CommunicationSnapshot }> {
    const raw = await this.io.read(this.path);
    if (raw === null) {
      if (this.lastRevision >= 0) throw new Error("communication-store-missing-after-load");
      return { raw, snapshot: emptyCommunicationSnapshot() };
    }
    if (new TextEncoder().encode(raw).byteLength > TUTOR_COMMUNICATION_LIMITS.storeBytes) throw new Error("communication-store-too-large");
    let value: unknown; try { value = JSON.parse(raw); } catch { throw new Error("communication-store-corrupt"); }
    let snapshot: CommunicationSnapshot;
    try { snapshot = validateCommunicationSnapshot(value); } catch { throw new Error("communication-store-invalid"); }
    if (snapshot.revision < this.lastRevision) throw new Error("communication-store-revision-regressed");
    this.lastRevision = snapshot.revision; return { raw, snapshot };
  }
  read(): Promise<CommunicationSnapshot> { return this.enqueue(async () => structuredClone((await this.load()).snapshot)); }
  transact<T>(change: (snapshot: CommunicationSnapshot) => T): Promise<T> {
    return this.enqueue(async () => {
      const { raw, snapshot } = await this.load(), previous = JSON.stringify(snapshot), result = change(snapshot);
      // Exact replays do not write or advance the store revision.
      if (JSON.stringify(snapshot) === previous) return structuredClone(result);
      snapshot.revision++;
      const checked = validateCommunicationSnapshot(snapshot);
      if (communicationBytes(checked) > TUTOR_COMMUNICATION_LIMITS.storeBytes) throw new Error("communication-store-too-large");
      try { await this.io.compareWrite(this.path, raw, JSON.stringify(checked)); }
      catch { throw new Error("communication-store-write-not-confirmed"); }
      this.lastRevision = checked.revision; return structuredClone(result);
    });
  }
  async flush(): Promise<void> { await this.tail; }
}
