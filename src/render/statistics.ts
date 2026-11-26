import { COLORS, type Color, type Multiset } from "../core/multiset";
import type { Game } from "../game/game";
import { THEME, TOKEN_COLORS } from "./style";

type ChartMode = "deliveries" | "minute" | "onWay";
const MODES: readonly { id: ChartMode; label: string }[] = [
  { id: "deliveries", label: "Deliveries" },
  { id: "minute", label: "Per minute" },
  { id: "onWay", label: "On the way" },
];
const CHART_COLORS: readonly Color[] = ["blue", "red", "green", "yellow"];
const PIXELS_PER_SECOND = 1000 / 3600;
const SVG_NS = "http://www.w3.org/2000/svg";

function svgElement<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function timeLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

/** Full-screen, native-scrollable statistics dialog. */
export class StatisticsScreen {
  private readonly root = document.createElement("section");
  private readonly title = document.createElement("h1");
  private readonly closeButton = document.createElement("button");
  private readonly tabs = document.createElement("div");
  private readonly axis = document.createElement("div");
  private readonly scroll = document.createElement("div");
  private readonly chart = svgElement("svg", { role: "img" });
  private readonly buttons = new Map<ChartMode, HTMLButtonElement>();
  private game?: Game;
  private mode: ChartMode = "deliveries";
  private previousFocus?: HTMLElement;
  private hideTimer?: number;
  private showFrame?: number;
  private backdropPointer?: number;
  private drag?: { pointerId: number; x: number; scrollLeft: number };

  constructor(private readonly onClose: () => void) {
    this.root.className = "statistics";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-labelledby", "statistics-title");
    this.root.addEventListener("pointerdown", (event) => {
      if (event.target === this.root && event.button === 0) this.backdropPointer = event.pointerId;
    });
    this.root.addEventListener("pointerup", (event) => {
      if (event.pointerId === this.backdropPointer && event.target === this.root) this.close();
      this.backdropPointer = undefined;
    });
    this.root.addEventListener("pointercancel", () => { this.backdropPointer = undefined; });
    const panel = document.createElement("div");
    panel.className = "statistics-panel";
    const header = document.createElement("header");
    this.title.id = "statistics-title";
    this.title.textContent = "Delivery statistics";
    this.closeButton.type = "button";
    this.closeButton.className = "statistics-close";
    this.closeButton.textContent = "Close";
    this.closeButton.addEventListener("click", () => this.close());
    header.append(this.title, this.closeButton);
    this.tabs.className = "statistics-tabs";
    this.tabs.setAttribute("aria-label", "Statistic");
    for (const { id, label } of MODES) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        this.mode = id;
        this.render();
      });
      this.tabs.append(button);
      this.buttons.set(id, button);
    }
    const plot = document.createElement("div");
    plot.className = "statistics-plot";
    this.axis.className = "statistics-axis";
    this.axis.setAttribute("aria-hidden", "true");
    this.scroll.className = "statistics-scroll";
    this.scroll.tabIndex = 0;
    this.scroll.setAttribute("aria-label", "Scroll chart horizontally to see earlier or later times");
    this.scroll.append(this.chart);
    this.scroll.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "mouse" || event.button !== 0 || !(event.target instanceof Node) || !this.chart.contains(event.target)
        || this.scroll.scrollWidth <= this.scroll.clientWidth) return;
      this.drag = { pointerId: event.pointerId, x: event.clientX, scrollLeft: this.scroll.scrollLeft };
      this.scroll.setPointerCapture(event.pointerId);
      this.scroll.classList.add("statistics-dragging");
      event.preventDefault();
    });
    this.scroll.addEventListener("pointermove", (event) => {
      if (this.drag?.pointerId === event.pointerId) {
        this.scroll.scrollLeft = this.drag.scrollLeft + this.drag.x - event.clientX;
      }
    });
    const endDrag = (event: PointerEvent) => {
      if (this.drag?.pointerId !== event.pointerId) return;
      this.drag = undefined;
      this.scroll.classList.remove("statistics-dragging");
      if (this.scroll.hasPointerCapture(event.pointerId)) this.scroll.releasePointerCapture(event.pointerId);
    };
    this.scroll.addEventListener("pointerup", endDrag);
    this.scroll.addEventListener("pointercancel", endDrag);
    this.scroll.addEventListener("lostpointercapture", endDrag);
    plot.append(this.axis, this.scroll);
    panel.append(header, this.tabs, plot);
    this.root.append(panel);
    document.body.append(this.root);
    window.addEventListener("resize", () => {
      if (this.game) this.render();
    });
  }

  get open(): boolean {
    return !!this.game;
  }

  show(game: Game): void {
    if (this.game) return;
    window.clearTimeout(this.hideTimer);
    if (this.showFrame !== undefined) window.cancelAnimationFrame(this.showFrame);
    this.game = game;
    this.mode = "deliveries";
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.title.textContent = game.survivalFailed ? "Survival statistics" : "Delivery statistics";
    this.root.hidden = false;
    this.render();
    this.scroll.scrollLeft = this.scroll.scrollWidth;
    this.showFrame = window.requestAnimationFrame(() => {
      this.root.classList.add("statistics-visible");
      this.showFrame = undefined;
    });
    this.closeButton.focus();
  }

  close(): void {
    if (!this.game) return;
    this.game = undefined;
    this.backdropPointer = undefined;
    if (this.drag && this.scroll.hasPointerCapture(this.drag.pointerId)) this.scroll.releasePointerCapture(this.drag.pointerId);
    this.drag = undefined;
    this.scroll.classList.remove("statistics-dragging");
    if (this.showFrame !== undefined) window.cancelAnimationFrame(this.showFrame);
    this.showFrame = undefined;
    this.root.classList.remove("statistics-visible");
    this.hideTimer = window.setTimeout(() => { this.root.hidden = true; }, 180);
    this.onClose();
    this.previousFocus?.focus();
    this.previousFocus = undefined;
  }

  private render(): void {
    const game = this.game;
    if (!game) return;
    for (const [mode, button] of this.buttons) button.setAttribute("aria-pressed", String(mode === this.mode));
    const labels: Record<ChartMode, string> = {
      deliveries: "Cumulative deliveries to matching goals",
      minute: "Deliveries in each minute (the current minute may be incomplete)",
      onWay: "Deliveries on the way",
    };
    this.chart.setAttribute("aria-label", `${labels[this.mode]}, stacked by color over time`);
    const now = game.statistics.sinkDeaths.reduce((time, death) => Math.max(time, death.time),
      Math.max(game.sim.time, game.completedAt ?? game.sim.time));
    const history = game.statistics.history(now, game.sim.liveTokens());
    const minutes = game.statistics.deliveriesPerMinute(now);
    const mode = this.mode;
    const series: { time: number; values: Multiset }[] = mode === "minute"
      ? minutes.map((minute) => ({ time: minute.time, values: minute.deliveries }))
      : history.map((point) => ({ time: point.time, values: mode === "onWay" ? point.alive : point.deliveries }));
    const duration = (Math.floor(now / 60) + 1) * 60;
    const width = Math.max(this.scroll.clientWidth, Math.ceil(duration * PIXELS_PER_SECOND), 1);
    const height = Math.max(100, Math.min(300, window.innerHeight - 300));
    const maximum = series.reduce((max, point) =>
      Math.max(max, COLORS.reduce((sum, color) => sum + (point.values[color] ?? 0), 0)), 1);
    const magnitude = 10 ** Math.floor(Math.log10(maximum / 4));
    const step = Math.max(1, ([1, 2, 2.5, 5, 10].find((factor) => factor * magnitude >= maximum / 4) ?? 10) * magnitude);
    const ceiling = step * 4;
    const scrollLeft = this.scroll.scrollLeft;
    this.chart.replaceChildren();
    this.chart.setAttribute("width", String(width));
    this.chart.setAttribute("height", String(height + 30));
    this.chart.setAttribute("viewBox", `0 0 ${width} ${height + 30}`);
    this.axis.style.height = `${height}px`;
    this.axis.replaceChildren();
    const ink = `#${THEME.ink.toString(16).padStart(6, "0")}`;
    for (let i = 0; i <= 4; i++) {
      const y = height * (1 - i / 4);
      this.chart.append(svgElement("line", { x1: 0, x2: width, y1: y, y2: y, stroke: ink, "stroke-opacity": 0.13 }));
      const label = document.createElement("span");
      label.style.top = `${y}px`;
      label.textContent = (ceiling * i / 4).toLocaleString(undefined, { maximumFractionDigits: 1 });
      this.axis.append(label);
    }
    const x = (time: number) => 10 + Math.max(0, Math.min(1, time / duration)) * Math.max(0, width - 20);
    const y = (value: number) => height - value / ceiling * height;
    if (this.mode === "minute") {
      for (const point of series) {
        let bottom = 0;
        const left = x(point.time);
        const right = x(Math.min(duration, point.time + 60));
        for (const color of CHART_COLORS) {
          const value = point.values[color] ?? 0;
          if (value) this.chart.append(svgElement("rect", {
            x: left, y: y(bottom + value), width: Math.max(0, right - left - 1), height: height * value / ceiling,
            fill: `#${TOKEN_COLORS[color].toString(16).padStart(6, "0")}`,
          }));
          bottom += value;
        }
      }
    } else {
      const points = series.length === 1 ? [...series, { ...series[0], time: duration }] : series;
      for (let colorIndex = 0; colorIndex < CHART_COLORS.length; colorIndex++) {
        const color = CHART_COLORS[colorIndex];
        const lower = (values: Multiset) => CHART_COLORS.slice(0, colorIndex).reduce((sum, c) => sum + (values[c] ?? 0), 0);
        const top = points.map((point) => `${x(point.time)},${y(lower(point.values) + (point.values[color] ?? 0))}`);
        const bottom = [...points].reverse().map((point) => `${x(point.time)},${y(lower(point.values))}`);
        this.chart.append(svgElement("polygon", {
          points: [...top, ...bottom].join(" "),
          fill: `#${TOKEN_COLORS[color].toString(16).padStart(6, "0")}`,
        }));
      }
    }
    if (game.statistics.endlessAt !== undefined && game.statistics.endlessAt <= now) {
      const position = x(game.statistics.endlessAt);
      this.chart.append(svgElement("line", {
        x1: position, x2: position, y1: 0, y2: height, stroke: "#000000", "stroke-width": 2,
        "data-marker": "endless", "aria-label": `Switched to endless at ${timeLabel(game.statistics.endlessAt)}`,
      }));
    }
    const tick = [10, 30, 60, 300, 600, 1200, 1800, 3600, 7200, 14400]
      .find((interval) => interval * width / duration >= 90) ?? 28800;
    for (let time = 0; time <= duration; time += tick) {
      const end = width - x(time) < 45;
      const label = svgElement("text", {
        x: end ? width - 2 : x(time) + 2, y: height + 20, fill: ink, "font-size": 12,
        "text-anchor": end ? "end" : "start",
      });
      label.textContent = timeLabel(time);
      this.chart.append(label);
    }
    for (const sink of game.statistics.sinkCreations) {
      if (sink.time > now) continue;
      const colors = sink.colors.length ? sink.colors : [undefined];
      colors.forEach((color, index) => {
        this.chart.append(svgElement("rect", {
          x: x(sink.time) + (index - (colors.length - 1) / 2) * 3 - 1.5, y: height + 1,
          width: 3, height: 6, rx: 1.5,
          fill: color ? `#${TOKEN_COLORS[color].toString(16).padStart(6, "0")}` : ink,
          "data-marker": "sink-creation",
          "aria-label": `${color ? `${color} ` : ""}sink created at ${timeLabel(sink.time)}`,
        }));
      });
    }
    for (const death of game.statistics.sinkDeaths) {
      if (death.time > now) continue;
      death.colors.forEach((color, index) => {
        const offset = (index - (death.colors.length - 1) / 2) * 2;
        const cx = x(death.time) + offset;
        const cy = height + 15;
        this.chart.append(svgElement("path", {
          d: `M ${cx - 4} ${cy - 4} L ${cx + 4} ${cy + 4} M ${cx + 4} ${cy - 4} L ${cx - 4} ${cy + 4}`,
          fill: "none", stroke: `#${TOKEN_COLORS[color].toString(16).padStart(6, "0")}`,
          "stroke-width": 2.5, "stroke-linecap": "round", "data-marker": "sink-death",
          "aria-label": `${color} sink starved at ${timeLabel(death.time)}`,
        }));
      });
    }
    this.scroll.scrollLeft = scrollLeft;
    this.scroll.classList.toggle("statistics-draggable", this.scroll.scrollWidth > this.scroll.clientWidth);
  }
}
