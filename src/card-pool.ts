import type { AnchorMark } from "./decorations-plan.js";
import { buildMarginCard, disposeMarginCard } from "./margin-card.js";

/** Keep live DOM (drag, focus, selection and unsaved dialogue) across reflows. */
export class CardPool {
  private entries = new Map<string, { card: HTMLElement; signature: string }>();

  public get(mark: AnchorMark, options: Parameters<typeof buildMarginCard>[1]): HTMLElement {
    const signature = JSON.stringify([mark, options.skin, options.showReview]);
    const old = this.entries.get(mark.id);
    if (old && (old.signature === signature || old.card.dataset["dragging"] ||
      old.card.contains(old.card.ownerDocument.activeElement))) {
      old.card.hidden = false;
      return old.card;
    }
    if (old) disposeMarginCard(old.card);
    const { card } = buildMarginCard(mark, options);
    this.entries.set(mark.id, { card, signature });
    return card;
  }

  public retain(ids: ReadonlySet<string>): void {
    for (const [id, entry] of this.entries) {
      if (ids.has(id)) {
        entry.card.hidden = !entry.card.dataset["dragging"];
        continue;
      }
      disposeMarginCard(entry.card);
      this.entries.delete(id);
    }
  }

  public clear(): void { this.retain(new Set()); }
}
