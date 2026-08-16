// Minimal in-memory stand-in for the slice of the Obsidian API that VaultStore
// touches, so the store's file I/O can be unit-tested under vitest's node
// environment (there is no real Obsidian runtime in tests). Only the surface the
// store actually uses is implemented; TFile / TFolder are real classes so the
// store's `instanceof` checks resolve against the very classes it imports.

export class TFile {
  public readonly path: string;
  public readonly name: string;
  public readonly basename: string;
  public readonly extension: string;
  public constructor(path: string) {
    this.path = path;
    this.name = path.split("/").pop() ?? path;
    const dot = this.name.lastIndexOf(".");
    this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
    this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
  }
}

export class TFolder {
  public readonly path: string;
  public readonly children: Array<TFile | TFolder>;
  public constructor(path: string, children: Array<TFile | TFolder> = []) {
    this.path = path;
    this.children = children;
  }
}

export function normalizePath(path: string): string {
  const cleaned = path
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return cleaned || "/";
}

/** The raw filesystem adapter (used by the store only for the JSON index cache). */
class MockAdapter {
  public readonly store = new Map<string, string>();
  public async exists(path: string): Promise<boolean> {
    return this.store.has(path);
  }
  public async read(path: string): Promise<string> {
    return this.store.get(path) ?? "";
  }
  public async write(path: string, content: string): Promise<void> {
    this.store.set(path, content);
  }
  public async list(): Promise<{ files: string[]; folders: string[] }> {
    return { files: [], folders: [] };
  }
}

export class MockVault {
  public readonly files = new Map<string, string>();
  public readonly folders = new Set<string>();
  public readonly adapter = new MockAdapter();
  public readonly configDir = ".obsidian";

  public getAbstractFileByPath(path: string): TFile | TFolder | null {
    if (this.files.has(path)) return new TFile(path);
    if (this.folders.has(path)) return new TFolder(path, this.directChildren(path));
    return null;
  }

  public async create(path: string, content: string): Promise<TFile> {
    this.files.set(path, content);
    this.ensureParents(path);
    return new TFile(path);
  }

  public async modify(file: TFile, content: string): Promise<void> {
    this.files.set(file.path, content);
  }

  public async read(file: TFile): Promise<string> {
    return this.files.get(file.path) ?? "";
  }

  public async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const next = fn(this.files.get(file.path) ?? "");
    this.files.set(file.path, next);
    return next;
  }

  public async delete(file: TFile | TFolder): Promise<void> {
    this.files.delete(file.path);
    this.folders.delete(file.path);
  }

  public async createFolder(path: string): Promise<void> {
    this.folders.add(path);
  }

  private ensureParents(path: string): void {
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      const parent = path.slice(0, slash);
      this.folders.add(parent);
      slash = parent.lastIndexOf("/");
    }
  }

  /** Direct children of a folder (one level); sub-folders are returned empty. */
  private directChildren(folder: string): Array<TFile | TFolder> {
    const prefix = folder ? `${folder}/` : "";
    const children: Array<TFile | TFolder> = [];
    const subfolders = new Set<string>();
    const consider = (candidate: string, isFolder: boolean): void => {
      if (candidate === folder || !candidate.startsWith(prefix)) return;
      const rest = candidate.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        if (isFolder) {
          if (!subfolders.has(candidate)) {
            subfolders.add(candidate);
            children.push(new TFolder(candidate));
          }
        } else {
          children.push(new TFile(candidate));
        }
        return;
      }
      const sub = prefix + rest.slice(0, slash);
      if (!subfolders.has(sub)) {
        subfolders.add(sub);
        children.push(new TFolder(sub));
      }
    };
    for (const path of this.files.keys()) consider(path, false);
    for (const path of this.folders) consider(path, true);
    return children;
  }
}

/** An App-like object carrying the mock vault (cast to App at the call site). */
export function createMockApp(): { vault: MockVault } {
  return { vault: new MockVault() };
}
