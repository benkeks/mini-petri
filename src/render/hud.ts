import { Container, Graphics, Rectangle, Text } from "pixi.js";
import { COLORS } from "../core/multiset";
import type { Game } from "../game/game";
import { brushesOf, sameBrush, type Brush, type Controller } from "../input/controller";
import { THEME, TOKEN_COLORS } from "./style";

const TOOL_SIZE = 48;
const TOOL_GAP = 8;
/** Room for the hint line above the toolbar. */
const HINT_SPACE = 34;

export interface HudActions {
  restart(): void;
  selectLevel(index: number): void;
  selectBrush(b: Brush): void;
}

interface ToolButton {
  brush: Brush;
  root: Container;
  bg: Graphics;
}

const POP_TIME = 0.55;
const CONFETTI = 36;

interface Confetto {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: number;
  r: number;
}

/** Back-out easing: overshoots a little before settling at 1. */
function easeOutBack(k: number): number {
  const c = 1.9;
  return 1 + (c + 1) * (k - 1) ** 3 + c * (k - 1) ** 2;
}

/** Screen-space overlay: time, goal progress, level picker, toolbar, hint and the level-won popup. */
export class Hud {
  readonly root = new Container();
  private readonly title: Text;
  private readonly stats: Text;
  private readonly restart: Text;
  private readonly hint: Text;
  private readonly levelPicker = new Container();
  private readonly toolbar = new Container();
  private tools: ToolButton[] = [];
  private toolSize = TOOL_SIZE;
  /** Dims the net and swallows taps while the level-won popup is shown. */
  private readonly shade = new Graphics();
  private readonly popup = new Container();
  private readonly card = new Graphics();
  private readonly heading: Text;
  private readonly detail: Text;
  private readonly againButton = new Container();
  private readonly nextButton = new Container();
  private readonly confettiLayer = new Graphics();
  private confetti: Confetto[] = [];
  /** Real seconds since the popup appeared, or undefined while it is hidden. */
  private shownFor?: number;
  private width = 0;
  private height = 0;

  constructor(
    private game: Game,
    private levelIndex: number,
    private readonly levelCount: number,
    private readonly controller: Controller,
    private readonly actions: HudActions,
  ) {
    const onRestart = () => actions.restart();
    const style = { fontFamily: THEME.font, fill: THEME.ink };
    this.title = new Text({ text: game.level.name, style: { ...style, fontSize: 18, fontWeight: "bold" } });
    this.stats = new Text({ text: "", style: { ...style, fontSize: 15 } });
    this.restart = new Text({ text: "↻ restart", style: { ...style, fontSize: 16 } });
    this.restart.anchor.set(1, 0);
    this.restart.eventMode = "static";
    this.restart.cursor = "pointer";
    this.restart.on("pointertap", onRestart);
    this.hint = new Text({
      text: "",
      style: { ...style, fontSize: 13, fill: 0x6e685e, wordWrap: true, wordWrapWidth: 600, align: "center" },
    });
    this.hint.anchor.set(0.5, 1);

    this.shade.eventMode = "static";
    this.heading = new Text({ text: "Level complete!", style: { ...style, fontSize: 32, fontWeight: "bold" } });
    this.heading.anchor.set(0.5);
    this.heading.position.set(0, -38);
    this.detail = new Text({ text: "", style: { ...style, fontSize: 17, fill: 0x6e685e } });
    this.detail.anchor.set(0.5);
    this.detail.position.set(0, 4);
    const button = (c: Container, label: string, onTap: () => void) => {
      const bg = new Graphics().roundRect(-72, -20, 144, 40, 20).fill(THEME.ink);
      const text = new Text({ text: label, style: { ...style, fontSize: 18, fontWeight: "bold", fill: 0xffffff } });
      text.anchor.set(0.5);
      c.addChild(bg, text);
      c.eventMode = "static";
      c.cursor = "pointer";
      c.hitArea = new Rectangle(-72, -20, 144, 40);
      c.on("pointertap", onTap);
    };
    button(this.againButton, "↻ again", onRestart);
    button(this.nextButton, "next →", () => actions.selectLevel(this.levelIndex + 1));
    this.card.roundRect(-170, -90, 340, 180, 18).fill(THEME.background).stroke({ width: 3, color: THEME.ink });
    this.card.eventMode = "static";
    this.popup.addChild(this.card, this.againButton, this.nextButton, this.heading, this.detail);

    this.root.addChild(
      this.title,
      this.stats,
      this.toolbar,
      this.hint,
      this.shade,
      this.confettiLayer,
      this.popup,
      this.levelPicker,
      this.restart,
    );
    this.buildToolbar();
    this.hidePopup();
  }

  setGame(game: Game, levelIndex: number): void {
    this.game = game;
    this.levelIndex = levelIndex;
    this.title.text = game.level.name;
    this.buildToolbar();
    this.hidePopup();
  }

  /** Positions HUD elements and returns the screen heights reserved at the top and bottom. */
  layout(width: number, height: number): { top: number; bottom: number } {
    this.width = width;
    this.height = height;
    this.title.position.set(16, 10);
    this.stats.position.set(16, 36);
    this.restart.position.set(width - 16, 12);
    this.layoutLevelPicker();
    this.popup.position.set(width / 2, height / 2);
    this.shade.clear().rect(0, 0, width, height).fill(THEME.ink);

    const n = this.tools.length;
    this.toolSize = Math.min(TOOL_SIZE, (width - 16) / Math.max(1, n) - TOOL_GAP);
    const size = this.toolSize;
    const toolbarH = n > 1 ? size + 16 : 0;
    this.tools.forEach((b, i) => {
      b.root.position.set(width / 2 + (i - (n - 1) / 2) * (size + TOOL_GAP), height - 8 - size / 2);
      b.root.scale.set(size / TOOL_SIZE);
    });
    this.toolbar.visible = n > 1;

    this.hint.style.wordWrapWidth = Math.min(600, width - 32);
    this.hint.position.set(width / 2, height - toolbarH - 8);
    this.hint.visible = this.shownFor === undefined;
    this.hint.style.fontSize = width > 480 ? 13 : 11;
    return { top: 64, bottom: toolbarH + HINT_SPACE };
  }

  /** One round button per level, left of the restart button; the current one is filled. */
  private layoutLevelPicker(): void {
    for (const c of this.levelPicker.removeChildren()) c.destroy({ children: true });
    const r = 13;
    // Beside the restart button if there is room next to the title, else in the row below.
    const narrow = this.width < 440;
    const right = narrow ? this.width - 16 : this.width - 16 - this.restart.width - 18;
    const y = narrow ? 50 : 12 + r - 2;
    for (let i = 0; i < this.levelCount; i++) {
      const c = new Container();
      const current = i === this.levelIndex;
      c.addChild(new Graphics().circle(0, 0, r).fill(current ? THEME.ink : THEME.background).stroke({ width: 2, color: THEME.ink }));
      const t = new Text({
        text: String(i + 1),
        style: { fontFamily: THEME.font, fontSize: 14, fontWeight: "bold", fill: current ? 0xffffff : THEME.ink },
      });
      t.anchor.set(0.5);
      c.addChild(t);
      c.position.set(right - (this.levelCount - 1 - i) * (2 * r + 8) - r, y);
      c.eventMode = "static";
      c.cursor = "pointer";
      c.hitArea = new Rectangle(-r - 4, -r - 4, 2 * r + 8, 2 * r + 8);
      c.on("pointertap", () => this.actions.selectLevel(i));
      this.levelPicker.addChild(c);
    }
  }

  private buildToolbar(): void {
    for (const c of this.toolbar.removeChildren()) c.destroy({ children: true });
    this.tools = brushesOf(this.game).map((brush) => {
      const root = new Container();
      const bg = new Graphics();
      const icon = new Graphics();
      drawIcon(icon, brush);
      root.addChild(bg, icon);
      root.eventMode = "static";
      root.cursor = "pointer";
      root.hitArea = new Rectangle(-TOOL_SIZE / 2 - 4, -TOOL_SIZE / 2 - 4, TOOL_SIZE + 8, TOOL_SIZE + 8);
      root.on("pointertap", () => this.actions.selectBrush(brush));
      this.toolbar.addChild(root);
      return { brush, root, bg };
    });
  }

  /** `dt` is real elapsed time; the popup keeps animating while the game is frozen. */
  update(dt: number): void {
    const g = this.game;
    for (const b of this.tools) {
      const active = sameBrush(b.brush, this.controller.brush);
      const h = TOOL_SIZE / 2;
      b.bg.clear().roundRect(-h, -h, 2 * h, 2 * h, 12).fill(active ? 0xffffff : THEME.background).stroke({
        width: active ? 3.5 : 2,
        color: active ? THEME.ink : THEME.muted,
      });
      b.root.y = this.height - 8 - this.toolSize / 2 - (active ? 4 : 0);
    }
    const hint = this.controller.hint();
    if (this.hint.text !== hint) this.hint.text = hint;
    const sinks = new Set(g.level.goals.map((goal) => goal.sinkId)).size;
    this.stats.text = `goals ${g.resolved.size}/${sinks}   time ${g.sim.time.toFixed(0)}s`;
    if (g.complete && this.shownFor === undefined) this.showPopup();
    if (this.shownFor !== undefined) this.animatePopup(dt);
  }

  private hidePopup(): void {
    this.shownFor = undefined;
    this.shade.visible = this.popup.visible = false;
    this.hint.visible = true;
    this.confetti = [];
    this.confettiLayer.clear();
  }

  private showPopup(): void {
    this.shownFor = 0;
    this.shade.visible = this.popup.visible = true;
    this.hint.visible = false;
    this.detail.text = `all goals met in ${this.game.completedAt!.toFixed(0)}s`;
    const hasNext = this.levelIndex + 1 < this.levelCount;
    this.nextButton.visible = hasNext;
    this.againButton.position.set(hasNext ? -78 : 0, 52);
    this.nextButton.position.set(78, 52);
    const scale = Math.min(1, (this.width - 24) / 340);
    this.confetti = Array.from({ length: CONFETTI }, (_, i) => {
      const a = (i / CONFETTI) * Math.PI * 2 + Math.random() * 0.3;
      const v = (260 + Math.random() * 260) * scale;
      return {
        x: this.width / 2,
        y: this.height / 2,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - 180,
        color: TOKEN_COLORS[COLORS[i % COLORS.length]],
        r: 5 + Math.random() * 3,
      };
    });
  }

  private animatePopup(dt: number): void {
    const t = (this.shownFor! += dt);
    const k = Math.min(1, t / POP_TIME);
    const fit = Math.min(1, (this.width - 24) / 340);
    this.shade.alpha = 0.3 * Math.min(1, t / 0.3);
    this.popup.scale.set(Math.max(0, easeOutBack(k)) * fit);
    this.popup.alpha = Math.min(1, t / 0.15);
    // A gentle bob once the popup has settled.
    this.popup.y = this.height / 2 + (k >= 1 ? Math.sin((t - POP_TIME) * 2.5) * 4 : 0);

    const c = this.confettiLayer.clear();
    const fade = Math.max(0, 1 - Math.max(0, t - 1.2) / 0.8);
    if (fade <= 0) return;
    for (const p of this.confetti) {
      p.vy += 700 * dt;
      p.vx *= 1 - 1.5 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      c.circle(p.x, p.y, p.r).fill({ color: p.color, alpha: fade }).stroke({ width: 2, color: 0xffffff, alpha: fade });
    }
  }
}

/** Icons of the toolbar, drawn around (0, 0) within TOOL_SIZE. */
function drawIcon(g: Graphics, b: Brush): void {
  const ink = THEME.ink;
  const bar = (x: number, w = 8, h = 24, color: number = ink) => g.roundRect(x - w / 2, -h / 2, w, h, 3).fill(color);
  switch (b.kind) {
    case "fire":
      bar(0);
      for (const a of [-0.6, 0, 0.6].flatMap((d) => [d, Math.PI + d])) {
        g.moveTo(Math.cos(a) * 9, Math.sin(a) * 15).lineTo(Math.cos(a) * 15, Math.sin(a) * 19).stroke({ width: 2.5, color: ink, cap: "round" });
      }
      break;
    case "place":
      g.circle(0, 0, 13).fill(0xffffff).stroke({ width: 3.5, color: ink });
      break;
    case "kit": {
      bar(0, 6, 22);
      const side = (dir: "in" | "out", x: number) => {
        const dots = b.kit.ports.filter((p) => p.dir === dir).flatMap((p) => Array<number>(p.count ?? 1).fill(p.color ? TOKEN_COLORS[p.color] : ink));
        dots.forEach((c, i) => g.circle(x, (i - (dots.length - 1) / 2) * 11, 4.5).fill(c));
      };
      side("in", -13);
      side("out", 13);
      break;
    }
    case "remove":
      for (const s of [1, -1]) g.moveTo(-10, -10 * s).lineTo(10, 10 * s).stroke({ width: 4, color: THEME.warn, cap: "round" });
      break;
    case "auto":
      g.circle(0, 0, 14).stroke({ width: 3, color: ink });
      g.moveTo(0, 0).lineTo(0, -9).stroke({ width: 3, color: ink, cap: "round" });
      g.moveTo(0, 0).lineTo(6, 4).stroke({ width: 3, color: ink, cap: "round" });
      break;
    case "faster":
      for (const x of [-7, 4]) g.moveTo(x - 4, -10).lineTo(x + 5, 0).lineTo(x - 4, 10).stroke({ width: 3.5, color: ink, cap: "round", join: "round" });
      break;
    case "capacity":
      g.circle(0, 0, 14).stroke({ width: 3, color: ink });
      g.moveTo(-7, 0).lineTo(7, 0).moveTo(0, -7).lineTo(0, 7).stroke({ width: 3, color: ink, cap: "round" });
      break;
  }
}
