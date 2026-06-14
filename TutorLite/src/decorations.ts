// CodeMirror decorations for annotated source text: a configurable inline style
// hugging the selected span, plus a small clickable comment marker that hides
// the raw `^block-id`. Obsidian provides @codemirror/state and @codemirror/view
// at runtime (externalised by the build), matching the full plugin's approach.
// The pure planning lives in decorations-plan.ts so it can be unit-tested.

import { StateEffect, StateField } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate
} from "@codemirror/view";
import { setIcon } from "obsidian";
import type { HighlightStyle } from "./settings.js";
import {
  planDecorations,
  type AnchorMark,
  type DecoPlan
} from "./decorations-plan.js";

export type { AnchorMark } from "./decorations-plan.js";

export type MarkerConfig = {
  marks: AnchorMark[];
  style: HighlightStyle;
  showMarker: boolean;
  marginComments: boolean;
  marginPaper: boolean;
  marginHideLink: boolean;
  inlineReview: boolean;
};

const DEFAULT_CONFIG: MarkerConfig = {
  marks: [],
  style: "dotted-underline",
  showMarker: true,
  marginComments: true,
  marginPaper: false,
  marginHideLink: false,
  inlineReview: true
};

/** Push a new highlight/marker configuration into the editor. */
export const setAnnotationMarks = StateEffect.define<MarkerConfig>();

/** Toggle whether a single annotation's margin card is expanded. */
export const toggleMarginCard = StateEffect.define<string>();

/** Set of annotation ids whose margin cards are currently expanded. */
export const marginExpandedField = StateField.define<ReadonlySet<string>>({
  create: () => new Set(),
  update(value, transaction) {
    let next: Set<string> | null = null;
    for (const effect of transaction.effects) {
      if (effect.is(toggleMarginCard)) {
        next ??= new Set(value);
        if (next.has(effect.value)) next.delete(effect.value);
        else next.add(effect.value);
      }
    }
    return next ?? value;
  }
});

let markerClickHandler: ((id: string, el: HTMLElement) => void) | null = null;

/** Wire what happens when a marker is clicked (the plugin opens the popover). */
export function setMarkerClickHandler(
  handler: ((id: string, el: HTMLElement) => void) | null
): void {
  markerClickHandler = handler;
}

/** Invoke the marker click handler (also used by margin comment cards). */
export function invokeMarkerClick(id: string, el: HTMLElement): void {
  markerClickHandler?.(id, el);
}

class MarkerWidget extends WidgetType {
  public constructor(private readonly id: string) {
    super();
  }

  public override eq(other: MarkerWidget): boolean {
    return other.id === this.id;
  }

  public override toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "atl-marker";
    el.setAttribute("data-atl-id", this.id);
    el.setAttribute("aria-label", "Show annotation");
    setIcon(el, "message-square");
    el.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      markerClickHandler?.(this.id, el);
    });
    return el;
  }

  public override ignoreEvent(): boolean {
    return true;
  }
}

function toRanges(plans: DecoPlan[]): Range<Decoration>[] {
  return plans.map((plan) => {
    if (plan.kind === "style") {
      return Decoration.mark({
        class: plan.className,
        ...(plan.id ? { attributes: { "data-atl-id": plan.id } } : {})
      }).range(plan.from, plan.to);
    }
    if (plan.kind === "hide") {
      return Decoration.replace({}).range(plan.from, plan.to);
    }
    // A point widget sitting just after the annotation's underlined span.
    return Decoration.widget({
      widget: new MarkerWidget(plan.id),
      side: plan.side
    }).range(plan.pos);
  });
}

export const markerConfigField = StateField.define<MarkerConfig>({
  create: () => DEFAULT_CONFIG,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setAnnotationMarks)) return effect.value;
    }
    return value;
  }
});

const annotationViewPlugin = ViewPlugin.fromClass(
  class {
    public decorations: DecorationSet;

    public constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    public update(update: ViewUpdate): void {
      const configChanged =
        update.startState.field(markerConfigField) !==
        update.state.field(markerConfigField);
      if (update.docChanged || configChanged) {
        this.decorations = this.build(update.view);
      }
    }

    private build(view: EditorView): DecorationSet {
      const config = view.state.field(markerConfigField);
      const plans = planDecorations(
        view.state.doc,
        config.marks,
        config.style,
        config.showMarker
      );
      return Decoration.set(toRanges(plans), true);
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

// Clicking an annotated (underlined) span opens that annotation's card. The
// end-of-line marker widget handles its own clicks (and stops propagation), so
// this only fires for the highlight spans, which carry data-atl-id.
const annotationClickHandler = EditorView.domEventHandlers({
  mousedown(event) {
    const target = event.target as HTMLElement | null;
    const el = target?.closest<HTMLElement>("[data-atl-id]");
    if (!el || el.classList.contains("atl-marker")) return false;
    const id = el.getAttribute("data-atl-id");
    if (!id) return false;
    event.preventDefault();
    markerClickHandler?.(id, el);
    return true;
  }
});

/** The editor extension to register (config field + decorating view plugin). */
export const annotationDecorations = [
  markerConfigField,
  marginExpandedField,
  annotationViewPlugin,
  annotationClickHandler
];
