import type { ChangeDesc } from "@codemirror/state";
import type { BoardAnchor, BoardMarkdownAnchorRecord, BoardMarkdownAnchorState } from "./board-types.js";
import { cloneBoardValue as clone } from "./board-clone.js";

export type MarkdownBoardBlock = { from: number; to: number; quote: string; blockId?: string; legacyKey: string };
const CONTEXT = 120;

export function boardTextVersion(text: string): string {
  return `md:${text.length}:${boardTextFingerprint(text)}`;
}
export function boardTextFingerprint(text: string): string {
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** Source blocks, independent of live-preview widgets and DOM virtualization. */
export function indexMarkdownBoardBlocks(text: string): MarkdownBoardBlock[] {
  const lines: Array<{ text: string; from: number; to: number }> = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    lines.push({ text: line.replace(/\r$/, ""), from: offset, to: offset + line.replace(/\r$/, "").length });
    offset += line.length + 1;
  }
  const blocks: MarkdownBoardBlock[] = [];
  const heading = /^ {0,3}#{1,6}(?:\s|$)/;
  const fence = /^ {0,3}(`{3,}|~{3,})/;
  const math = /^\s*(\$\$|\\\[)\s*$/;
  const divider = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
  for (let start = 0; start < lines.length;) {
    const first = lines[start]!;
    if (!first.text.trim()) { start++; continue; }
    let end = start;
    const fenced = fence.exec(first.text), equation = math.exec(first.text);
    if (start === 0 && first.text === "---") {
      while (end + 1 < lines.length && !/^(---|\.\.\.)\s*$/.test(lines[++end]!.text)) { /* YAML frontmatter */ }
    } else if (fenced) {
      const marker = fenced[1]!;
      const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
      while (end + 1 < lines.length && !close.test(lines[++end]!.text)) { /* Blank lines are part of code. */ }
    } else if (equation) {
      const close = equation[1] === "$$" ? /^\s*\$\$\s*$/ : /^\s*\\\]\s*$/;
      while (end + 1 < lines.length && !close.test(lines[++end]!.text)) { /* Block math. */ }
    } else if (!heading.test(first.text) && !divider.test(first.text)) {
      const quoted = /^\s*>/.test(first.text);
      while (end + 1 < lines.length) {
        const next = lines[end + 1]!.text;
        if (!next.trim() || heading.test(next) || fence.test(next) || math.test(next)) break;
        if (quoted !== /^\s*>/.test(next)) break;
        // A setext underline belongs to the preceding paragraph. Other thematic
        // breaks start their own block instead of merging adjacent paragraphs.
        if (divider.test(next) && !/^ {0,3}(?:=+|-+)\s*$/.test(next)) break;
        end++;
      }
    }
    if (end + 1 < lines.length && /^\s*\^[\w-]+\s*$/.test(lines[end + 1]!.text)) end++;
    const from = first.from, to = lines[end]!.to;
    const quote = text.slice(from, to).trim();
    const blockId = quote.match(/(?:^|\s)\^([A-Za-z0-9_-]+)\s*$/)?.[1];
    blocks.push({ from, to, quote, ...(blockId ? { blockId } : {}), legacyKey: blockId ? `block:${blockId}` : `text:${boardTextFingerprint(quote)}` });
    start = end + 1;
  }
  const counts = new Map<string, number>();
  for (const block of blocks) counts.set(block.legacyKey, (counts.get(block.legacyKey) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!, key = block.legacyKey;
    if ((counts.get(key) ?? 0) > 1) {
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      block.legacyKey += `:${boardTextFingerprint(`${blocks[index - 1]?.quote ?? ""}|${blocks[index + 1]?.quote ?? ""}`)}:${occurrence}`;
    }
  }
  return blocks;
}

/** One instance per source document. Mirrored split transactions are deduplicated by content version. */
export class BoardAnchorRegistry {
  private text = "";
  private state: BoardMarkdownAnchorState;
  private readonly seenVersions = new Set<string>();
  // Obsidian may implement text undo as replacement of an entire paragraph,
  // rather than the inverse of each insertion. Exact, bounded source snapshots
  // allow its former IDs to survive that replacement without fuzzy matching.
  private readonly priorStates = new Map<string, {text:string; entries:BoardMarkdownAnchorRecord[]; size:number}>();
  private priorStateSize = 0;
  public constructor(text: string, saved?: BoardMarkdownAnchorState, legacy: readonly BoardAnchor[] = []) {
    this.state = saved ? clone(saved) : { textVersion: "", entries: [] };
    this.rebuild(text);
    for (const anchor of legacy) {
      if (anchor.kind !== "markdown" || this.resolve(anchor)) continue;
      const candidates = this.state.entries.filter((entry) => entry.status === "located" && entry.quote === anchor.quote);
      let match = candidates.length === 1 ? candidates[0] : undefined;
      if (!match && anchor.sourceLine !== undefined) {
        const from = text.split("\n").slice(0, anchor.sourceLine).reduce((sum, line) => sum + line.length + 1, 0);
        match = candidates.find((entry) => entry.from === from);
      }
      if (match) match.aliases = [...new Set([...match.aliases, anchor.key])];
      else this.state.entries.push({ id: this.newId(), from: 0, to: 0, quote: anchor.quote.slice(0, 20000), before: "", after: "", aliases: [anchor.key], status: "missing" });
    }
  }
  public get entries(): readonly BoardMarkdownAnchorRecord[] { return this.state.entries; }
  public get version(): string { return this.state.textVersion; }
  /** Incremental reading renders retain old section snapshots. Only reuse a
   * section when its complete source prefix is unchanged at the same offsets. */
  public isRenderedPrefixCurrent(source: string, end: number): boolean {
    return end >= 0 && end <= source.length && end <= this.text.length
      && source.slice(0, end) === this.text.slice(0, end)
      && (end === this.text.length || this.text[end] === "\n")
      && !this.state.entries.some(entry => entry.status === "located" && entry.from < end && entry.to > end);
  }
  public snapshot(): BoardMarkdownAnchorState { return clone(this.state); }
  public resolve(anchor: BoardAnchor | string): BoardMarkdownAnchorRecord | undefined {
    const key = typeof anchor === "string" ? anchor : anchor.kind === "markdown" ? anchor.key : "";
    return this.state.entries.find((entry) => entry.id === key)
      ?? this.state.entries.find((entry) => entry.aliases.includes(key));
  }
  public anchorForRange(from: number, to: number): Extract<BoardAnchor, { kind: "markdown" }> | undefined {
    const found = this.state.entries.find((entry) => entry.status === "located" && entry.from <= from && entry.to >= to)
      ?? this.state.entries.find((entry) => entry.status === "located" && entry.from <= from && entry.to > from);
    return found ? this.anchor(found) : undefined;
  }
  public anchor(entry: BoardMarkdownAnchorRecord): Extract<BoardAnchor, { kind: "markdown" }> {
    return { kind: "markdown", key: entry.id, quote: entry.quote, sourceLine: this.text.slice(0, entry.from).split("\n").length - 1 };
  }
  public reconcile(text: string): boolean {
    if (boardTextVersion(text) === this.state.textVersion) return false;
    this.rebuild(text);
    return true;
  }
  public applyChanges(beforeText: string, afterText: string, changes: ChangeDesc): boolean {
    const beforeVersion = boardTextVersion(beforeText), afterVersion = boardTextVersion(afterText);
    if (afterVersion === this.state.textVersion) return false;
    // Two splits may receive their mirrored transactions at different times.
    // An old mirror must not rewind the latest shared anchors. A real undo has
    // beforeVersion === current, so remains able to restore an earlier version.
    if (beforeVersion !== this.state.textVersion && this.seenVersions.has(afterVersion)) return false;
    if (beforeVersion !== this.state.textVersion || changes.length !== beforeText.length || changes.newLength !== afterText.length)
      return this.reconcile(afterText);
    const blocks = indexMarkdownBoardBlocks(afterText);
    const mapped = new Map<string, MarkdownBoardBlock>();
    const prior = this.priorStates.get(afterVersion);
    if (prior?.text === afterText) {
      const blockAt = new Map(blocks.map(block => [block.from, block]));
      const currentIds = new Set(this.state.entries.map(entry => entry.id));
      for (const entry of prior.entries) {
        if (entry.status !== "located" || !currentIds.has(entry.id)) continue;
        const block = blockAt.get(entry.from);
        if (block && block.to === entry.to && block.quote.slice(0,20000) === entry.quote && block.blockId === entry.blockId)
          mapped.set(entry.id, block);
      }
      // A complete previous document matches, including duplicate order and
      // context. Reserve these IDs before a newer transient block can take them.
      this.rebuild(afterText, mapped, blocks);
      return true;
    }
    for (const entry of this.state.entries) {
      let removed = false;
      changes.iterChangedRanges((from, to) => {
        if (from < to && from <= entry.from && to >= entry.to) removed = true;
      });
      if (entry.status !== "located" || removed) continue;
      const from = changes.mapPos(entry.from, 1), to = changes.mapPos(entry.to, -1);
      let low = 0, high = blocks.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (blocks[middle]!.from <= from) low = middle + 1; else high = middle;
      }
      const candidate = blocks[low - 1];
      if (candidate && candidate.to >= to && to > from) mapped.set(entry.id, candidate);
    }
    // Multiple former blocks merging into one cannot both own its coordinate
    // origin. Retain them as missing until an unambiguous restoration exists.
    const destinations = new Map<number, number>();
    for (const block of mapped.values()) destinations.set(block.from, (destinations.get(block.from) ?? 0) + 1);
    for (const [id, block] of mapped) if (destinations.get(block.from)! > 1) mapped.delete(id);
    this.rebuild(afterText, mapped, blocks);
    return true;
  }
  private newId(): string { return `ANCHOR-${globalThis.crypto.randomUUID()}`; }
  private update(entry: BoardMarkdownAnchorRecord, block: MarkdownBoardBlock, text: string): void {
    entry.from = block.from; entry.to = block.to;
    entry.quote = block.quote.slice(0, 20000);
    entry.before = text.slice(Math.max(0, block.from - CONTEXT), block.from);
    entry.after = text.slice(block.to, block.to + CONTEXT);
    if (block.blockId) entry.blockId = block.blockId; else delete entry.blockId;
    entry.aliases = [...new Set([...entry.aliases, block.legacyKey])].slice(-64);
    entry.status = "located";
  }
  private rebuild(text: string, mapped?: Map<string, MarkdownBoardBlock>, blocks = indexMarkdownBoardBlocks(text)): void {
    if (this.state.textVersion && boardTextVersion(this.text) === this.state.textVersion && this.text !== text) {
      const entries=clone(this.state.entries);
      const size=this.text.length+JSON.stringify(entries).length;
      const old=this.priorStates.get(this.state.textVersion);
      if(old){this.priorStates.delete(this.state.textVersion);this.priorStateSize-=old.size;}
      if(size<=2_000_000){this.priorStates.set(this.state.textVersion,{text:this.text,entries,size});this.priorStateSize+=size;}
      while(this.priorStates.size>32||this.priorStateSize>2_000_000){
        const key=this.priorStates.keys().next().value!;
        this.priorStateSize-=this.priorStates.get(key)!.size;this.priorStates.delete(key);
      }
    }
    const used = new Set<number>();
    const byQuote = new Map<string, MarkdownBoardBlock[]>(), byBlockId = new Map<string, MarkdownBoardBlock[]>();
    for (const block of blocks) {
      const quote = block.quote.slice(0, 20000);
      if (!byQuote.has(quote)) byQuote.set(quote, []);
      byQuote.get(quote)!.push(block);
      if (block.blockId) {
        if (!byBlockId.has(block.blockId)) byBlockId.set(block.blockId, []);
        byBlockId.get(block.blockId)!.push(block);
      }
    }
    const sameVersion = this.state.textVersion === boardTextVersion(text);
    // Reserve transaction-mapped destinations before reviving tombstones with
    // matching text. Otherwise an older deleted duplicate could steal the live
    // block whose source position is still known exactly.
    for (const entry of this.state.entries) {
      const candidate = mapped?.get(entry.id);
      if (candidate) { this.update(entry, candidate, text); used.add(candidate.from); }
    }
    for (const entry of this.state.entries) {
      if (mapped?.has(entry.id)) continue;
      let candidate: MarkdownBoardBlock | undefined;
      {
        let candidates = (entry.blockId ? byBlockId.get(entry.blockId) : byQuote.get(entry.quote))?.filter((block) => !used.has(block.from)) ?? [];
        if (candidates.length > 1 && sameVersion && entry.status === "located") candidates = candidates.filter((block) => block.from === entry.from && block.to === entry.to);
        if (candidates.length > 1) candidates = candidates.filter((block) =>
          (entry.before.length > 0 || entry.after.length > 0) &&
          text.slice(Math.max(0, block.from - entry.before.length), block.from) === entry.before &&
          text.slice(block.to, block.to + entry.after.length) === entry.after);
        if (candidates.length === 1) candidate = candidates[0];
      }
      if (candidate && !used.has(candidate.from)) {
        this.update(entry, candidate, text); used.add(candidate.from);
      } else entry.status = "missing";
    }
    for (const block of blocks) if (!used.has(block.from)) {
      const entry: BoardMarkdownAnchorRecord = { id: this.newId(), from: block.from, to: block.to, quote: "", before: "", after: "", aliases: [], status: "located" };
      this.update(entry, block, text); this.state.entries.push(entry);
    }
    this.text = text;
    this.state.textVersion = boardTextVersion(text);
    this.seenVersions.add(this.state.textVersion);
    if (this.seenVersions.size > 256) this.seenVersions.delete(this.seenVersions.values().next().value!);
  }
}
