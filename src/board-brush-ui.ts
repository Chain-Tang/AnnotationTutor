import type { BoardBrushKind, BoardBrushStyle } from "./board-types.js";
import { defaultBoardBrush } from "./board-brushes.js";
import { generateBrushDabs, renderBrushDabs, resolveBoardBrush } from "./board-paint.js";
import { brushEngineFor, type BrushResources } from "./board-brush-engine.js";

export const BOARD_BRUSH_DEFAULT_WIDTHS: Readonly<Record<BoardBrushKind, number>> = {
  pen: 3,
  fountain: 5,
  pencil: 4,
  marker: 12,
  highlighter: 18,
  chalk: 14,
  crayon: 16,
  watercolor: 24,
  sumi: 18,
  oil: 32,
};

const PRESETS: Readonly<Record<BoardBrushKind, readonly number[]>> = {
  pen: [1, 2, 3, 5, 8],
  fountain: [1, 3, 5, 8, 12],
  pencil: [1, 2, 4, 6, 10],
  marker: [4, 8, 12, 20, 32],
  highlighter: [8, 12, 18, 24, 36],
  chalk: [4, 8, 14, 24, 40],
  crayon: [4, 8, 16, 24, 40],
  watercolor: [8, 16, 24, 40, 64],
  sumi: [3, 8, 18, 32, 64],
  oil: [8, 16, 32, 64, 128],
};

export function boardBrushSizePresets(kind: BoardBrushKind, max: number): number[] {
  return [...new Set(PRESETS[kind].map(value => Math.min(max, value)))];
}

/** Logarithmic mapping gives line-art brushes much finer low-end control. */
export function brushSizeFromSlider(position: number, min: number, max: number): number {
  const ratio = Math.max(0, Math.min(1, position));
  return Math.max(min, Math.min(max, Math.round(min * Math.pow(max / min, ratio) * 10) / 10));
}

export function sliderFromBrushSize(value: number, min: number, max: number): number {
  return Math.max(0, Math.min(1, Math.log(Math.max(min, Math.min(max, value)) / min) / Math.log(max / min)));
}

export function paintBoardBrushPreview(
  canvas: HTMLCanvasElement,
  kind: BoardBrushKind,
  width: number,
  color = "#6f55d9",
  style?: BoardBrushStyle,
  resources?: BrushResources,
): void {
  const rectWidth = Math.max(120, canvas.clientWidth || 180);
  const rectHeight = Math.max(40, canvas.clientHeight || 52);
  const ratio = Math.min(2, canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1);
  canvas.width = Math.round(rectWidth * ratio);
  canvas.height = Math.round(rectHeight * ratio);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rectWidth, rectHeight);
  const points = Array.from({ length: 31 }, (_, index) => ({
    x: 10 + index * (rectWidth - 20) / 30,
    y: rectHeight * 0.54 + Math.sin(index / 4.4) * rectHeight * 0.12,
    pressure: 0.18 + Math.sin(index / 30 * Math.PI) * 0.78,
    tiltX: -34 + index * 1.8,
    tiltY: 22,
    twist: 315,
    t: index * 15,
  }));
  const recipe = style ?? defaultBoardBrush(kind, 0x51f15e);
  if(recipe.engineVersion===2)brushEngineFor(recipe).render(context,points,recipe,Math.max(1,width),color,resources);
  else {
    const dabs = generateBrushDabs(points, recipe, Math.max(1, width));
    renderBrushDabs(context, dabs, color, kind === "highlighter" || kind === "sumi" ? "multiply" : "source-over", recipe.preventSelfOverlap);
  }
}

/** Screen-space nib outline shared by the overlay and Studio canvases. */
export function positionBoardBrushCursor(
  element: HTMLElement,
  event: PointerEvent,
  kind: BoardBrushKind,
  width: number,
  hostRect: DOMRect,
  scale = 1,
): void {
  if (event.pointerType === "touch") { element.hidden = true; return; }
  const brush = resolveBoardBrush(defaultBoardBrush(kind));
  const diameter = Math.max(2, Math.min(240, width * scale));
  element.hidden = false;
  element.dataset.kind = kind;
  element.style.width = `${diameter}px`;
  element.style.height = `${Math.max(2, diameter * brush.roundness)}px`;
  element.style.left = `${event.clientX - hostRect.left}px`;
  element.style.top = `${event.clientY - hostRect.top}px`;
  element.style.transform = `translate(-50%, -50%) rotate(${brush.nibAngle}rad)`;
}

export type BrushSizeControlOptions = {
  kind: BoardBrushKind;
  color?: string;
  value: number;
  min: number;
  max: number;
  compact?: boolean;
  label: string;
  pressureLabel?: string;
  style?: () => BoardBrushStyle;
  resources?: BrushResources;
  onInput(value: number): void;
  onCommit(value: number): void;
};

export class BrushSizeControl {
  public readonly element: HTMLDivElement;
  public readonly range: HTMLInputElement;
  public readonly number: HTMLInputElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly presets: HTMLDivElement;
  private readonly pressure: HTMLDivElement | null;
  private kind: BoardBrushKind;
  private color: string;
  private value: number;

  public constructor(parent: HTMLElement, private readonly options: BrushSizeControlOptions) {
    const doc = parent.ownerDocument;
    this.kind = options.kind;
    this.color = options.color ?? "#6f55d9";
    this.value = this.clamp(options.value);
    this.element = doc.createElement("div");
    this.element.className = `atl-brush-size-control${options.compact ? " is-compact" : ""}`;
    const header = doc.createElement("div");
    header.className = "atl-brush-size-header";
    const label = doc.createElement("span");
    label.textContent = options.label;
    this.number = doc.createElement("input");
    this.number.type = "number";
    this.number.min = String(options.min);
    this.number.max = String(options.max);
    this.number.step = "0.1";
    this.number.setAttribute("aria-label", options.label);
    this.number.title = options.label;
    const unit = doc.createElement("span");
    unit.textContent = "px";
    header.append(label, this.number, unit);
    this.canvas = doc.createElement("canvas");
    this.canvas.className = "atl-brush-size-preview";
    this.canvas.setAttribute("aria-hidden", "true");
    this.range = doc.createElement("input");
    this.range.type = "range";
    this.range.className = "atl-brush-size-range";
    this.range.min = "0";
    this.range.max = "1000";
    this.range.step = "1";
    this.range.setAttribute("aria-label", options.label);
    this.range.title = options.label;
    this.presets = doc.createElement("div");
    this.presets.className = "atl-brush-size-presets";
    this.pressure = options.pressureLabel ? doc.createElement("div") : null;
    if (this.pressure) this.pressure.className = "atl-brush-pressure-range";
    this.element.append(header, this.canvas, this.range, this.presets);
    if (this.pressure) this.element.append(this.pressure);
    parent.append(this.element);
    this.range.addEventListener("input", () => this.preview(brushSizeFromSlider(Number(this.range.value) / 1000, options.min, options.max)));
    this.range.addEventListener("change", () => options.onCommit(this.value));
    this.number.addEventListener("input", () => {
      const parsed = Number(this.number.value);
      if (Number.isFinite(parsed)) this.preview(parsed);
    });
    const commitNumber = () => { this.setValue(Number(this.number.value)); options.onCommit(this.value); };
    this.number.addEventListener("blur", commitNumber);
    this.number.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); commitNumber(); this.number.select(); } });
    this.render();
  }

  public setKind(kind: BoardBrushKind, value = BOARD_BRUSH_DEFAULT_WIDTHS[kind]): void {
    this.kind = kind;
    this.setValue(value);
  }

  public setColor(color: string): void {
    this.color = color;
    this.render(false);
  }

  public refresh(): void { this.render(false); }

  public setValue(value: number): void {
    this.value = this.clamp(Number.isFinite(value) ? value : this.options.min);
    this.render();
  }

  public step(direction: -1 | 1): number {
    const values = boardBrushSizePresets(this.kind, this.options.max);
    const next = direction < 0
      ? [...values].reverse().find(value => value < this.value) ?? values[0]!
      : values.find(value => value > this.value) ?? values.at(-1)!;
    this.setValue(next);
    this.options.onInput(this.value);
    this.options.onCommit(this.value);
    return this.value;
  }

  private clamp(value: number): number {
    return Math.round(Math.max(this.options.min, Math.min(this.options.max, value)) * 10) / 10;
  }

  private preview(value: number): void {
    this.value = this.clamp(value);
    this.render(false);
    this.options.onInput(this.value);
  }

  private render(rebuildPresets = true): void {
    this.number.value = String(this.value);
    this.range.value = String(Math.round(sliderFromBrushSize(this.value, this.options.min, this.options.max) * 1000));
    paintBoardBrushPreview(this.canvas, this.kind, Math.min(this.value, this.options.compact ? 30 : 44), this.color, this.options.style?.(), this.options.resources);
    if (this.pressure) {
      const brush = resolveBoardBrush(this.options.style?.() ?? defaultBoardBrush(this.kind));
      const min = this.value * (1 - brush.pressureSize + brush.pressureSize * 0.02);
      this.pressure.textContent = this.options.pressureLabel?.replace("{min}", min.toFixed(1)).replace("{max}", this.value.toFixed(1)) ?? "";
    }
    if (!rebuildPresets) return;
    this.presets.replaceChildren();
    for (const preset of boardBrushSizePresets(this.kind, this.options.max)) {
      const button = this.element.ownerDocument.createElement("button");
      button.type = "button";
      button.textContent = String(preset);
      button.className = preset === this.value ? "is-active" : "";
      button.setAttribute("aria-pressed", String(preset === this.value));
      button.addEventListener("click", () => {
        this.setValue(preset);
        this.options.onInput(this.value);
        this.options.onCommit(this.value);
      });
      this.presets.append(button);
    }
  }
}
